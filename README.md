SMART Habit Tracker
A full-stack habit tracking web application built with Node.js, Express, and MySQL.
The system allows users to create habits, track daily progress, analyze productivity, and manage their profiles, with an additional admin panel for user management.

Core Logic
Streak System
Tracks consecutive days a habit is completed using date comparison logic.
Productivity Score
Calculated daily based on:
Number of completed habits
Total time spent
Score formula:
score = (completed_habits × 10) + (total_minutes / 10)      (max score = 100)

Tech Stack
Backend: Node.js, Express.js
Frontend: EJS, HTML, CSS
Database: MySQL
Authentication: express-session
Security: bcrypt (password hashing), input validation (express-validator)

Security Considerations
Passwords are hashed using bcrypt
Input validation implemented using express-validator
Session-based authentication
Role-based authorization (admin/user)


This project is built for learning and demonstration purposes, focusing on backend logic, authentication, and data tracking.
!!! When you want to run the project dont forget to change database credentials with yours
