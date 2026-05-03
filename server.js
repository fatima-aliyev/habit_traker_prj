const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./db');
const { body, validationResult } = require('express-validator');
const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(session({
    secret: 'habittracer',
    resave: false,
    saveUninitialized: false
}));
const auth = (req, res, next) => {
    if (req.session.user) return next();
    res.redirect('/login');
};
async function computeStreak(habitId, userId) {
    const [logs] = await db.query(
        `SELECT log_date FROM habit_logs 
         WHERE habit_id = ? AND user_id = ? 
         ORDER BY log_date DESC`,
        [habitId, userId]
    );
    if (logs.length === 0) return 0;
    let streak = 0;
    let expectedDate = new Date().toISOString().split('T')[0];
    for (let log of logs) {
        let logDate = log.log_date.toISOString().split('T')[0];
        if (logDate === expectedDate) {
            streak++;
            let prev = new Date(expectedDate);
            prev.setDate(prev.getDate() - 1);
            expectedDate = prev.toISOString().split('T')[0];
        } else break;
    }
    return streak;
}
async function updateProductivityScore(userId, date) {
    const [logs] = await db.query(
        `SELECT COUNT(*) as completed, SUM(duration) as total_minutes
         FROM habit_logs WHERE user_id = ? AND log_date = ?`,
        [userId, date]
    );
    const completed = logs[0]?.completed || 0;
    const minutes = logs[0]?.total_minutes || 0;
    let score = (completed * 10) + Math.floor(minutes / 10);
    score = Math.min(score, 100);
    await db.query(
        `INSERT INTO daily_stats (user_id, stat_date, productivity_score, total_completed, total_minutes)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
            productivity_score = VALUES(productivity_score),
            total_completed = VALUES(total_completed),
            total_minutes = VALUES(total_minutes)`,
        [userId, date, score, completed, minutes]
    );
    return score;
}
app.route('/register')
.get((req, res) => { res.render('register', { errors: {}, old: {} }); })
.post([
    body('name').trim().notEmpty().withMessage('Username required'),
    body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password min 6 chars'),
    body('confirm_password').custom((value, { req }) => {
        if (value !== req.body.password) throw new Error('Passwords do not match');
        return true;
    })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        let mapped = {};
        errors.array().forEach(e => mapped[e.path] = e.msg);
        return res.render('register', { errors: mapped, old: req.body });
    }
    const { name, email, password } = req.body;
    const [u1] = await db.query('SELECT id FROM users WHERE name=?', [name]);
    if (u1.length) return res.render('register', { errors: { name: 'Username already exists' }, old: req.body });
    const [u2] = await db.query('SELECT id FROM users WHERE email=?', [email]);
    if (u2.length) return res.render('register', { errors: { email: 'Email already exists' }, old: req.body });
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (name,email,password) VALUES (?,?,?)', [name, email, hash]);
    res.redirect('/login');
});
app.route('/login')
.get((req, res) => { res.render('login', { message: '' }); })
.post(async (req, res) => {
    const [rows] = await db.query('SELECT * FROM users WHERE name=?', [req.body.name]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
        return res.render('login', { message: 'Invalid credentials' });
    }
    req.session.user = {
        id: user.id,
        name: user.name,
        role: user.role || 'user'
    };
   
    if (req.session.user.role === 'admin') {
        res.redirect('/admin');
    } else {
        res.redirect('/');
    }
});
const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).send('Access denied. Admins only.');
};
app.get('/admin', auth, isAdmin, async (req, res) => {
    const [users] = await db.query('SELECT id, name, email, role FROM users ORDER BY id');
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const dateLimit = sevenDaysAgo.toISOString().split('T')[0];
    
    const usersWithStatus = [];
    for (const user of users) {
        const [logs] = await db.query(
            `SELECT COUNT(*) as cnt FROM habit_logs WHERE user_id = ? AND log_date >= ?`,
            [user.id, dateLimit]
        );
        usersWithStatus.push({ ...user, active: logs[0].cnt > 0 });
    }
    res.render('admin', { users: usersWithStatus, message: req.query.msg || null });
});
app.post('/admin/delete/:id', auth, isAdmin, async (req, res) => {
    const userId = req.params.id;
    if (userId == req.session.user.id) return res.redirect('/admin?msg=Cannot+delete+yourself');
    await db.query('DELETE FROM users WHERE id=?', [userId]);
    await db.query('DELETE FROM habits WHERE user_id=?', [userId]);
    await db.query('DELETE FROM habit_logs WHERE user_id=?', [userId]);
    res.redirect('/admin?msg=User+deleted');
});
app.get('/', auth, async (req, res) => {
    const userId = req.session.user.id;
    const [habits] = await db.query('SELECT * FROM habits WHERE user_id=? ORDER BY id DESC', [userId]);
    const today = new Date().toISOString().split('T')[0];
    const [logs] = await db.query('SELECT habit_id, duration FROM habit_logs WHERE user_id=? AND log_date=?', [userId, today]);
    const completedToday = logs.map(l => l.habit_id);
    const durations = {};
    logs.forEach(l => { durations[l.habit_id] = l.duration; });

    const [weeklyData] = await db.query(`
        SELECT log_date, COUNT(*) as completed, SUM(duration) as total_minutes
        FROM habit_logs WHERE user_id=? AND log_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        GROUP BY log_date ORDER BY log_date ASC
    `, [userId]);

    const [totalCompleted] = await db.query('SELECT COUNT(*) as total FROM habit_logs WHERE user_id=?', [userId]);
    const [totalTime] = await db.query('SELECT SUM(duration) as total_minutes FROM habit_logs WHERE user_id=?', [userId]);
    const [todayScore] = await db.query('SELECT productivity_score FROM daily_stats WHERE user_id=? AND stat_date=?', [userId, today]);
    const [bestHabit] = await db.query(`
        SELECT h.name, COUNT(l.id) as completions
        FROM habits h JOIN habit_logs l ON h.id = l.habit_id
        WHERE h.user_id = ? GROUP BY h.id ORDER BY completions DESC LIMIT 1
    `, [userId]);

    res.render('dashboard', {
        currentUser: req.session.user,
        habits,
        completedToday,
        durations,
        weeklyData: JSON.stringify(weeklyData),
        totalCompleted: totalCompleted[0].total || 0,
        totalMinutes: totalTime[0].total_minutes || 0,
        todayProductivity: todayScore[0]?.productivity_score || 0,
        bestHabit: bestHabit[0] || null
    });
});
app.post('/habits', auth, async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.redirect('/');
    await db.query(
        'INSERT INTO habits (user_id,name,description) VALUES (?,?,?)',
        [req.session.user.id, name, description || '']
    );
    res.redirect('/');
});
app.post('/habits/toggle', auth, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const habitId = req.body.habit_id;
    const userId = req.session.user.id;
    const duration = parseInt(req.body.duration) || 0;
    const [existing] = await db.query('SELECT * FROM habit_logs WHERE habit_id=? AND user_id=? AND log_date=?', [habitId, userId, today]);
    if (existing.length > 0) {
        const oldDuration = existing[0].duration;
        await db.query('DELETE FROM habit_logs WHERE id=?', [existing[0].id]);
        await db.query('UPDATE habits SET total_time_spent = total_time_spent - ? WHERE id=?', [oldDuration, habitId]);
        const newStreak = await computeStreak(habitId, userId);
        await db.query('UPDATE habits SET current_streak = ?, last_completed_date = ? WHERE id=?', [newStreak, null, habitId]);
    } else {
        await db.query('INSERT INTO habit_logs (habit_id, user_id, log_date, duration) VALUES (?,?,?,?)', [habitId, userId, today, duration]);
        await db.query('UPDATE habits SET total_time_spent = total_time_spent + ? WHERE id=?', [duration, habitId]);
        const streak = await computeStreak(habitId, userId);
        await db.query('UPDATE habits SET current_streak = ?, last_completed_date = ? WHERE id=?', [streak, today, habitId]);
    }
    await updateProductivityScore(userId, today);
    res.redirect('/');
});

app.post('/habits/delete', auth, async (req, res) => {
    await db.query('DELETE FROM habits WHERE id=? AND user_id=?', [req.body.habit_id, req.session.user.id]);
    await db.query('DELETE FROM habit_logs WHERE habit_id=?', [req.body.habit_id]);
    res.redirect('/');
});

app.get('/stats', auth, async (req, res) => {
    const userId = req.session.user.id;
   
    let [weeklyRows] = await db.query(`
        SELECT log_date, COUNT(*) as completed, COALESCE(SUM(duration),0) as minutes
        FROM habit_logs WHERE user_id=? AND log_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        GROUP BY log_date ORDER BY log_date
    `, [userId]);
    const dates = [];
    for (let i = 6; i >= 0; i--) {
        let d = new Date(); d.setDate(d.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
    }
    const weeklyMap = {};
    weeklyRows.forEach(row => { weeklyMap[row.log_date.toISOString().split('T')[0]] = { completed: row.completed, minutes: row.minutes }; });
    const weekly = dates.map(date => ({ log_date: date, completed: weeklyMap[date]?.completed || 0, minutes: weeklyMap[date]?.minutes || 0 }));

    let [monthlyRows] = await db.query(`
        SELECT DATE_FORMAT(log_date, '%Y-%m-%d') as date, COUNT(*) as completed, COALESCE(SUM(duration),0) as minutes
        FROM habit_logs WHERE user_id=? AND log_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY log_date ORDER BY log_date
    `, [userId]);
    const monthDates = [];
    for (let i = 29; i >= 0; i--) {
        let d = new Date(); d.setDate(d.getDate() - i);
        monthDates.push(d.toISOString().split('T')[0]);
    }
    const monthlyMap = {};
    monthlyRows.forEach(row => { monthlyMap[row.date] = { completed: row.completed, minutes: row.minutes }; });
    const monthly = monthDates.map(date => ({ date: date, completed: monthlyMap[date]?.completed || 0, minutes: monthlyMap[date]?.minutes || 0 }));

    const [habitStats] = await db.query(`
        SELECT h.name, COUNT(l.id) as total_completions, COALESCE(SUM(l.duration),0) as total_minutes
        FROM habits h LEFT JOIN habit_logs l ON h.id = l.habit_id AND l.user_id = h.user_id
        WHERE h.user_id = ? GROUP BY h.id ORDER BY total_completions DESC
    `, [userId]);

    const [productivityTrend] = await db.query(`
        SELECT stat_date, productivity_score FROM daily_stats
        WHERE user_id=? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY) ORDER BY stat_date
    `, [userId]);

    res.render('stats', { currentUser: req.session.user, weekly, monthly, habitStats, productivityTrend });
});

app.get('/profile', auth, async (req, res) => {
    const [user] = await db.query('SELECT id,name,email FROM users WHERE id=?', [req.session.user.id]);
    res.render('profile', { user: user[0], errors: {}, message: "" });
});
app.post('/profile/update', auth, async (req, res) => {
    const { name, email, password } = req.body;
    let errors = {};
    const [u1] = await db.query('SELECT id FROM users WHERE name=? AND id!=?', [name, req.session.user.id]);
    if (u1.length) errors.name = 'Username already exists';
    const [u2] = await db.query('SELECT id FROM users WHERE email=? AND id!=?', [email, req.session.user.id]);
    if (u2.length) errors.email = 'Email already exists';
    if (password && password.length < 6) errors.password = 'Password min 6 chars';
    if (Object.keys(errors).length) {
        const [user] = await db.query('SELECT id,name,email FROM users WHERE id=?', [req.session.user.id]);
        return res.render('profile', { user: user[0], errors, message: 'Validation error' });
    }
    const updates = [], values = [];
    if (name) { updates.push('name=?'); values.push(name); req.session.user.name = name; }
    if (email) { updates.push('email=?'); values.push(email); }
    if (password && password.length >= 6) { const hash = await bcrypt.hash(password, 10); updates.push('password=?'); values.push(hash); }
    values.push(req.session.user.id);
    if (updates.length) await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id=?`, values);
    res.redirect('/profile');
});
app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });
app.listen(4000, () => console.log("SMART Habit Tracker running on http://localhost:4000"));
