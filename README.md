# ChatSpace — Render-ready real-time chat app

A simple real-time one-to-one chat application built with Node.js, Express, Socket.IO and PostgreSQL.

## Correct project structure

```text
render-chat-app/
├── package.json
├── server.js
├── render.yaml
├── .env.example
├── .gitignore
├── README.md
└── public/
    ├── index.html
    ├── app.js
    └── style.css
```

**Important:** `package.json`, `server.js`, and `render.yaml` belong in the repository root. Only the browser files belong inside `public/`.

## Render deployment

1. Upload the contents of this folder to the root of a GitHub repository. Do not put the whole project inside another folder.
2. In Render, create a PostgreSQL database.
3. Create a Node Web Service from the GitHub repository.
4. Leave **Root Directory** blank.
5. Build command: `npm install`
6. Start command: `npm start`
7. Add environment variables:
   - `DATABASE_URL` = Render PostgreSQL **Internal Database URL**
   - `JWT_SECRET` = a long random secret you create
   - `NODE_ENV` = `production`
8. Deploy.

Render supplies `PORT` automatically; the server uses `process.env.PORT`.

The application creates its PostgreSQL tables automatically on startup.

## Local development

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:10000`.
