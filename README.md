# ChatSpace Advanced v4

WhatsApp/Messenger-style real-time chat app designed for Render.

## Features
- User registration/login with bcrypt + JWT
- 1-to-1 chats and group chats
- Profile photo upload
- Image/file sharing
- Delivery/read receipts
- Message edit/delete
- Typing and online presence
- Browser notifications
- WebRTC voice/video calling with Socket.IO signaling
- Admin panel: user management, role promotion, disable/enable accounts
- PostgreSQL persistence
- Responsive mobile UI
- Socket.IO websocket + polling fallback

## Render
Build: `npm install`
Start: `npm start`
Root Directory: blank when these files are at the repository root.

Environment variables:
- `DATABASE_URL` = Render PostgreSQL Internal Database URL
- `JWT_SECRET` = long random secret
- `NODE_ENV` = `production`
- `MAX_FILE_MB` = optional, default 15
- `ADMIN_USERNAME` = optional username to promote to admin at startup

## Important file-storage note
This version stores uploaded files on the web service filesystem. Render web-service filesystems are ephemeral, so for permanent production media storage replace the local upload adapter with S3/Cloudinary/etc. The database and chat data remain in PostgreSQL.

## Calling
Voice/video uses browser WebRTC peer-to-peer media and Socket.IO for signaling. HTTPS is required in production for microphone/camera permissions. Users must allow camera/microphone access.

## Existing database
The startup migration uses `CREATE TABLE IF NOT EXISTS` and adds missing columns/indexes, so it can upgrade the previous ChatSpace database without deleting existing users/messages.
