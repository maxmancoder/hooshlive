# HooshLive - Persian News Dashboard

A news dashboard application that reads news from various sources including Telegram, YouTube, and RSS feeds.

## Features

- **Dark theme** with Persian interface
- **Live updates** with 5-minute intervals
- **Multiple source support**:
  - Telegram channels
  - YouTube channels
  - RSS feeds
- **Folder organization** for grouping sources
- **Pinning** important news items
- **Copy link** functionality
- **Search** functionality
- **Responsive design** for all devices

## Technology Stack

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js with Express
- Database: PostgreSQL (Aiven) with Prisma ORM
- Deployment: Render.com

## Getting Started

1. Clone the repository
2. Install dependencies: `npm install`
3. Set up environment variables:
   - `DATABASE_URL` (PostgreSQL connection string)
   - `DATABASE_CA_CERT` (optional, for Aiven SSL)
4. Run the application: `npm start`

## Deployment

This application is deployed on Render.com. The source code is available on GitHub.

## Screenshot

![HooshLive Persian News Dashboard](C:\Users\BlackLine\Downloads\HooshLive Persian News Dashboard.png)

![Screenshot of the application interface showing the dark theme with Persian text, Telegram/YouTube/RSS icons, and news feed]