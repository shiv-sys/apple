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
- `CLOUDINARY_CLOUD_NAME` Cloudinary cloud name
- `CLOUDINARY_API_KEY` Cloudinary API key
- `CLOUDINARY_API_SECRET` Cloudinary API secret (server-side only)

## Media storage
Uploads are stored in Cloudinary instead of the local `uploads/` directory, so profile photos and chat attachments persist across Render deployments and restarts.

Cloudinary folders used by the app:
- `chatspace/profiles` for profile photos
- `chatspace/attachments` for chat files and images

Set the three Cloudinary environment variables before deploying. The API secret is never exposed to the browser.

## Calling
WebRTC requires HTTPS and microphone/camera permission. The app uses a public STUN server for NAT discovery. For difficult networks, add a TURN server in `public/app.js` in the `iceServers` list.


## Voice/video calling
Calls use WebRTC for media and Socket.IO for signaling. The caller rings first; the recipient must explicitly **Accept** or **Reject**. Microphone/camera permissions are requested only after the call is accepted. The UI also supports mute, camera toggle, speaker toggle, call timeout, busy/rejected states, and ICE candidate queuing.

For networks where STUN is insufficient, configure a TURN server by exposing these frontend values in your deployment (for example by templating them into `public/index.html`): `CHATSPACE_TURN_URL`, `CHATSPACE_TURN_USERNAME`, and `CHATSPACE_TURN_CREDENTIAL`. For production, use a reputable TURN provider and keep credentials protected.


## Registration / database troubleshooting

Registration requires PostgreSQL. On Render, set `DATABASE_URL` in the service Environment Variables to the connection string of your PostgreSQL database. After deployment, open `/health/db`; it should return `{"ok":true,"database":"connected"}`. The `/health` endpoint also reports whether Cloudinary and the database are configured (without exposing secrets).

Cloudinary variables required for media uploads:
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

The API secret is server-only and must never be placed in frontend files.
