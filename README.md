# ChatSpace Advanced V5

A Render-ready WhatsApp/Messenger-style chat application.

## Included
- Registration/login, JWT session, password hashing
- One-to-one chats
- Group creation, member management and group messages
- Profile avatar upload and update
- Image/file attachments with size limits
- Delivery/read receipts and unread counts
- Edit/delete own messages
- Typing indicator and online/offline presence
- Browser notifications
- Voice/video WebRTC calls with Socket.IO signaling
- Admin dashboard with user search, role change, disable/enable and stats
- PostgreSQL schema migration compatible with the previous ChatSpace tables
- Responsive mobile-first UI

## Render
Build command: `npm install`
Start command: `npm start`
Root Directory: blank when project files are at repository root.

Environment variables:
- `DATABASE_URL` Render PostgreSQL Internal Database URL
- `JWT_SECRET` long random secret
- `NODE_ENV=production`
- `ADMIN_USERNAME` optional username to make admin
- `MAX_FILE_MB` optional, default 20

## Media storage
The default upload adapter stores files under `uploads/`. Render web services have ephemeral local disks, so production deployments that need permanent media should replace this adapter with S3-compatible storage or Cloudinary.

## Calling
WebRTC requires HTTPS and microphone/camera permission. The app uses a public STUN server for NAT discovery. For difficult networks, add a TURN server in `public/app.js` in the `iceServers` list.
