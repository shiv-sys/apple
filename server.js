require('dotenv').config();
const express=require('express');
const http=require('http');
const path=require('path');
const fs=require('fs');
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const cookieParser=require('cookie-parser');
const multer=require('multer');
const {Pool}=require('pg');
const {Server}=require('socket.io');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{transports:['websocket','polling'],pingInterval:20000,pingTimeout:30000,cors:{origin:true,credentials:true},maxHttpBufferSize:25*1024*1024});
const PORT=Number(process.env.PORT)||10000;
const JWT_SECRET=process.env.JWT_SECRET||'dev-only-change-this-secret';
const MAX_FILE_MB=Math.max(1,Math.min(100,Number(process.env.MAX_FILE_MB)||20));
const uploadDir=process.env.UPLOAD_DIR||path.join(__dirname,'uploads');
fs.mkdirSync(uploadDir,{recursive:true});
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false});
const db=(sql,params=[])=>pool.query(sql,params).then(r=>r.rows);

app.use(express.json({limit:'2mb'}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));
app.use('/uploads',express.static(uploadDir,{maxAge:'1d'}));
app.get('/health',(req,res)=>res.json({ok:true,service:'chatspace-advanced-v5',time:new Date().toISOString()}));

async function initDb(){
 if(!process.env.DATABASE_URL){console.warn('DATABASE_URL missing; app will not work with persistence.');return;}
 await db(`
 CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY, username VARCHAR(40) UNIQUE NOT NULL, display_name VARCHAR(80) NOT NULL,
  password_hash TEXT NOT NULL, avatar_url TEXT, role VARCHAR(20) NOT NULL DEFAULT 'user',
  is_disabled BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ
 );
 CREATE TABLE IF NOT EXISTS groups(
  id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, description TEXT, avatar_url TEXT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS group_members(
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member', joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(group_id,user_id)
 );
 CREATE TABLE IF NOT EXISTS messages(
  id BIGSERIAL PRIMARY KEY, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE, group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE,
  body TEXT, attachment_url TEXT, attachment_name TEXT, attachment_type TEXT, attachment_size BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), edited_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ
 );
 CREATE TABLE IF NOT EXISTS message_reads(
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(message_id,user_id)
 );
 CREATE TABLE IF NOT EXISTS notifications(
  id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL, title VARCHAR(160) NOT NULL, body TEXT, data JSONB,
  read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';
 ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT false;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
 ALTER TABLE messages ALTER COLUMN receiver_id DROP NOT NULL;
 ALTER TABLE messages ALTER COLUMN body DROP NOT NULL;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type TEXT;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_size BIGINT;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
 ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB;
 CREATE INDEX IF NOT EXISTS idx_messages_direct ON messages(sender_id,receiver_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id,group_id);
 CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at DESC);
 `);
 if(process.env.ADMIN_USERNAME){await db('UPDATE users SET role=\'admin\' WHERE username=$1',[String(process.env.ADMIN_USERNAME).trim().toLowerCase()]);}
}

function publicUser(u){return {id:u.id,username:u.username,displayName:u.display_name,avatarUrl:u.avatar_url||null,role:u.role||'user',isDisabled:!!u.is_disabled,lastSeen:u.last_seen||null};}
function tokenFor(u){return jwt.sign({id:u.id,username:u.username,role:u.role||'user'},JWT_SECRET,{expiresIn:'7d'});}
function getToken(req){return req.cookies.chat_token;}
async function auth(req,res,next){try{const t=getToken(req);if(!t)throw new Error('no token');const p=jwt.verify(t,JWT_SECRET);const rows=await db('SELECT * FROM users WHERE id=$1',[p.id]);if(!rows[0])return res.status(401).json({error:'Not authenticated.'});if(rows[0].is_disabled)return res.status(403).json({error:'This account is disabled.'});req.user=rows[0];next();}catch(e){res.status(401).json({error:'Not authenticated.'});}}
function admin(req,res,next){if(req.user?.role!=='admin')return res.status(403).json({error:'Admin access required.'});next();}
function setAuth(res,t){res.cookie('chat_token',t,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*86400000});}
function safeName(s){return String(s||'file').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120)||'file';}
const storage=multer.diskStorage({destination:uploadDir,filename:(req,file,cb)=>cb(null,Date.now()+'-'+crypto.randomBytes(7).toString('hex')+'-'+safeName(file.originalname))});
const upload=multer({storage,limits:{fileSize:MAX_FILE_MB*1024*1024}});

app.post('/api/register',async(req,res)=>{try{const username=String(req.body.username||'').trim().toLowerCase(),displayName=String(req.body.displayName||'').trim(),password=String(req.body.password||'');if(!/^[a-z0-9_]{3,40}$/.test(username))return res.status(400).json({error:'Username must be 3-40 characters: letters, numbers and _. '});if(displayName.length<2||displayName.length>80)return res.status(400).json({error:'Display name must be 2-80 characters.'});if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters.'});if((await db('SELECT id FROM users WHERE username=$1',[username])).length)return res.status(409).json({error:'Username already exists.'});const role=process.env.ADMIN_USERNAME?.trim().toLowerCase()===username?'admin':'user';const hash=await bcrypt.hash(password,12);const u=(await db('INSERT INTO users(username,display_name,password_hash,role,last_seen) VALUES($1,$2,$3,$4,NOW()) RETURNING *',[username,displayName,hash,role]))[0];const t=tokenFor(u);setAuth(res,t);res.json({user:publicUser(u),socketToken:t});}catch(e){console.error(e);res.status(500).json({error:'Registration failed.'});}});
app.post('/api/login',async(req,res)=>{try{const username=String(req.body.username||'').trim().toLowerCase(),password=String(req.body.password||'');const u=(await db('SELECT * FROM users WHERE username=$1',[username]))[0];if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:'Invalid username or password.'});if(u.is_disabled)return res.status(403).json({error:'This account is disabled.'});await db('UPDATE users SET last_seen=NOW() WHERE id=$1',[u.id]);u.last_seen=new Date();const t=tokenFor(u);setAuth(res,t);res.json({user:publicUser(u),socketToken:t});}catch(e){console.error(e);res.status(500).json({error:'Login failed.'});}});
app.post('/api/logout',(req,res)=>{res.clearCookie('chat_token');res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>res.json({user:publicUser(req.user)}));
app.get('/api/socket-token',auth,(req,res)=>res.json({socketToken:tokenFor(req.user)}));
app.get('/api/users',auth,async(req,res)=>{try{const q=String(req.query.q||'').trim();const rows=await db(q?`SELECT * FROM users WHERE id<>$1 AND is_disabled=false AND (username ILIKE $2 OR display_name ILIKE $2) ORDER BY display_name LIMIT 100`:`SELECT * FROM users WHERE id<>$1 AND is_disabled=false ORDER BY display_name LIMIT 100`,q?[req.user.id,'%'+q+'%']:[req.user.id]);res.json({users:rows.map(publicUser)});}catch(e){res.status(500).json({error:'Could not load users.'});}});
app.post('/api/profile',auth,upload.single('avatar'),async(req,res)=>{try{const name=String(req.body.displayName||req.user.display_name).trim();if(name.length<2||name.length>80)return res.status(400).json({error:'Display name must be 2-80 characters.'});let avatar=req.user.avatar_url;if(req.file)avatar='/uploads/'+req.file.filename;const u=(await db('UPDATE users SET display_name=$1,avatar_url=$2 WHERE id=$3 RETURNING *',[name,avatar,req.user.id]))[0];res.json({user:publicUser(u)});}catch(e){console.error(e);res.status(500).json({error:'Profile update failed.'});}});

async function directAllowed(a,b){const r=await db('SELECT id FROM users WHERE id=$1 AND is_disabled=false',[b]);return !!r[0];}
app.get('/api/conversations',auth,async(req,res)=>{try{const direct=await db(`SELECT u.*,x.last_body,x.last_attachment,x.last_at FROM users u LEFT JOIN LATERAL(SELECT body last_body,attachment_name last_attachment,created_at last_at FROM messages m WHERE m.group_id IS NULL AND ((m.sender_id=$1 AND m.receiver_id=u.id) OR (m.sender_id=u.id AND m.receiver_id=$1)) ORDER BY m.created_at DESC LIMIT 1)x ON true WHERE u.id<>$1 AND u.is_disabled=false ORDER BY x.last_at DESC NULLS LAST,u.display_name`,[req.user.id]);const groups=await db(`SELECT g.*,x.last_body,x.last_attachment,x.last_at FROM groups g JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=$1 LEFT JOIN LATERAL(SELECT body last_body,attachment_name last_attachment,created_at last_at FROM messages m WHERE m.group_id=g.id ORDER BY m.created_at DESC LIMIT 1)x ON true ORDER BY x.last_at DESC NULLS LAST,g.name`,[req.user.id]);res.json({conversations:direct.map(x=>({...publicUser(x),type:'direct',lastMessage:x.last_body||x.last_attachment||'',lastAt:x.last_at})),groups:groups.map(x=>({id:x.id,type:'group',name:x.name,description:x.description,avatarUrl:x.avatar_url,lastMessage:x.last_body||x.last_attachment||'',lastAt:x.last_at}))});}catch(e){console.error(e);res.status(500).json({error:'Could not load conversations.'});}});
app.get('/api/messages/direct/:userId',auth,async(req,res)=>{try{const other=Number(req.params.userId);if(!Number.isInteger(other))return res.status(400).json({error:'Invalid user.'});const rows=await db(`SELECT m.*,u.display_name sender_name,u.avatar_url sender_avatar,EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id=m.id AND mr.user_id=$1) AS is_read FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.group_id IS NULL AND ((m.sender_id=$1 AND m.receiver_id=$2) OR (m.sender_id=$2 AND m.receiver_id=$1)) ORDER BY m.created_at ASC LIMIT 1000`,[req.user.id,other]);await db(`INSERT INTO message_reads(message_id,user_id) SELECT m.id,$1 FROM messages m WHERE m.group_id IS NULL AND m.sender_id=$2 AND m.receiver_id=$1 ON CONFLICT DO NOTHING`,[req.user.id,other]);res.json({messages:rows});}catch(e){console.error(e);res.status(500).json({error:'Could not load messages.'});}});
app.get('/api/groups',auth,async(req,res)=>{const rows=await db(`SELECT g.*,gm.role member_role,(SELECT COUNT(*) FROM group_members x WHERE x.group_id=g.id) member_count,(SELECT m.created_at FROM messages m WHERE m.group_id=g.id ORDER BY m.created_at DESC LIMIT 1) last_at,(SELECT COALESCE(m.body,m.attachment_name,'') FROM messages m WHERE m.group_id=g.id ORDER BY m.created_at DESC LIMIT 1) last_message FROM groups g JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=$1 ORDER BY last_at DESC NULLS LAST,g.name`,[req.user.id]);res.json({groups:rows});});
app.post('/api/groups',auth,async(req,res)=>{try{const name=String(req.body.name||'').trim(),description=String(req.body.description||'').trim();const members=Array.isArray(req.body.memberIds)?req.body.memberIds.map(Number).filter(Number.isInteger):[];if(name.length<2||name.length>100)return res.status(400).json({error:'Group name must be 2-100 characters.'});const client=await pool.connect();try{await client.query('BEGIN');const g=(await client.query('INSERT INTO groups(name,description,owner_id) VALUES($1,$2,$3) RETURNING *',[name,description,req.user.id])).rows[0];const ids=[...new Set([req.user.id,...members])];for(const id of ids){await client.query('INSERT INTO group_members(group_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[g.id,id,id===req.user.id?'owner':'member']);}await client.query('COMMIT');res.json({group:g});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}catch(e){console.error(e);res.status(500).json({error:'Could not create group.'});}});
app.get('/api/groups/:id',auth,async(req,res)=>{try{const gid=Number(req.params.id);const gm=(await db('SELECT * FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,req.user.id]))[0];if(!gm)return res.status(403).json({error:'Not a group member.'});const g=(await db('SELECT * FROM groups WHERE id=$1',[gid]))[0];const members=await db('SELECT u.*,gm.role member_role FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=$1 ORDER BY gm.role DESC,u.display_name',[gid]);res.json({group:g,members:members.map(x=>({...publicUser(x),memberRole:x.member_role}))});}catch(e){res.status(500).json({error:'Could not load group.'});}});
app.get('/api/messages/group/:groupId',auth,async(req,res)=>{try{const gid=Number(req.params.groupId);const gm=(await db('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,req.user.id]))[0];if(!gm)return res.status(403).json({error:'Not a member.'});const rows=await db(`SELECT m.*,u.display_name sender_name,u.avatar_url sender_avatar,EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id=m.id AND mr.user_id=$1) AS is_read FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.group_id=$2 ORDER BY m.created_at ASC LIMIT 1000`,[req.user.id,gid]);await db(`INSERT INTO message_reads(message_id,user_id) SELECT m.id,$1 FROM messages m JOIN group_members gm ON gm.group_id=m.group_id WHERE m.group_id=$2 AND m.sender_id<>$1 ON CONFLICT DO NOTHING`,[req.user.id,gid]);res.json({messages:rows});}catch(e){res.status(500).json({error:'Could not load group messages.'});}});
app.post('/api/groups/:id/members',auth,async(req,res)=>{try{const gid=Number(req.params.id),uid=Number(req.body.userId);const me=(await db('SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,req.user.id]))[0];if(!me||!['owner','admin'].includes(me.role))return res.status(403).json({error:'Group admin access required.'});await db('INSERT INTO group_members(group_id,user_id,role) VALUES($1,$2,\'member\') ON CONFLICT DO NOTHING',[gid,uid]);res.json({ok:true});}catch(e){res.status(500).json({error:'Could not add member.'});}});
app.delete('/api/groups/:id/members/:userId',auth,async(req,res)=>{try{const gid=Number(req.params.id),uid=Number(req.params.userId);const me=(await db('SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,req.user.id]))[0];if(!me||!['owner','admin'].includes(me.role))return res.status(403).json({error:'Group admin access required.'});if(uid===req.user.id)return res.status(400).json({error:'Use leave group for yourself.'});await db('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,uid]);res.json({ok:true});}catch(e){res.status(500).json({error:'Could not remove member.'});}});

app.post('/api/upload',auth,upload.single('file'),async(req,res)=>{if(!req.file)return res.status(400).json({error:'No file selected.'});const isImage=(req.file.mimetype||'').startsWith('image/');res.json({url:'/uploads/'+req.file.filename,name:req.file.originalname,type:req.file.mimetype,size:req.file.size,isImage});});

app.patch('/api/messages/:id',auth,async(req,res)=>{try{const id=Number(req.params.id),body=String(req.body.body||'').trim();if(!body)return res.status(400).json({error:'Message cannot be empty.'});const m=(await db('SELECT * FROM messages WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL',[id,req.user.id]))[0];if(!m)return res.status(404).json({error:'Message not found.'});const row=(await db('UPDATE messages SET body=$1,edited_at=NOW() WHERE id=$2 RETURNING *',[body,id]))[0];const room=m.group_id?'group:'+m.group_id:'user:'+m.receiver_id;io.to(room).emit('message:edited',{messageId:id,body,editedAt:row.edited_at});if(!m.group_id)io.to('user:'+m.sender_id).emit('message:edited',{messageId:id,body,editedAt:row.edited_at});res.json({message:row});}catch(e){res.status(500).json({error:'Could not edit message.'});}});
app.delete('/api/messages/:id',auth,async(req,res)=>{try{const id=Number(req.params.id);const m=(await db('SELECT * FROM messages WHERE id=$1 AND sender_id=$2',[id,req.user.id]))[0];if(!m)return res.status(404).json({error:'Message not found.'});await db('UPDATE messages SET body=NULL,attachment_url=NULL,attachment_name=NULL,attachment_type=NULL,attachment_size=NULL,deleted_at=NOW() WHERE id=$1',[id]);const payload={messageId:id,deletedAt:new Date().toISOString()};if(m.group_id)io.to('group:'+m.group_id).emit('message:deleted',payload);else{io.to('user:'+m.receiver_id).emit('message:deleted',payload);io.to('user:'+m.sender_id).emit('message:deleted',payload);}res.json({ok:true});}catch(e){res.status(500).json({error:'Could not delete message.'});}});

app.get('/api/notifications',auth,async(req,res)=>{const rows=await db('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[req.user.id]);res.json({notifications:rows});});
app.post('/api/notifications/read',auth,async(req,res)=>{await db('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL',[req.user.id]);res.json({ok:true});});

app.get('/api/admin/stats',auth,admin,async(req,res)=>{const [u,m,g,online]=await Promise.all([db('SELECT COUNT(*)::int count FROM users'),db('SELECT COUNT(*)::bigint count FROM messages'),db('SELECT COUNT(*)::int count FROM groups'),db('SELECT COUNT(*)::int count FROM users WHERE last_seen>NOW()-INTERVAL \'2 minutes\'')]);res.json({users:u[0].count,messages:Number(m[0].count),groups:g[0].count,online:online[0].count});});
app.get('/api/admin/users',auth,admin,async(req,res)=>{const q=String(req.query.q||'').trim();const rows=await db(q?`SELECT * FROM users WHERE username ILIKE $1 OR display_name ILIKE $1 ORDER BY created_at DESC LIMIT 200`:`SELECT * FROM users ORDER BY created_at DESC LIMIT 200`,q?['%'+q+'%']:[]);res.json({users:rows.map(publicUser)});});
app.patch('/api/admin/users/:id',auth,admin,async(req,res)=>{try{const id=Number(req.params.id);const role=['user','admin'].includes(req.body.role)?req.body.role:null;const disabled=typeof req.body.isDisabled==='boolean'?req.body.isDisabled:null;const u=(await db('SELECT * FROM users WHERE id=$1',[id]))[0];if(!u)return res.status(404).json({error:'User not found.'});if(id===req.user.id&&disabled)return res.status(400).json({error:'You cannot disable yourself.'});const row=(await db('UPDATE users SET role=COALESCE($1,role),is_disabled=COALESCE($2,is_disabled) WHERE id=$3 RETURNING *',[role,disabled,id]))[0];if(disabled)io.to('user:'+id).emit('account:disabled');res.json({user:publicUser(row)});}catch(e){res.status(500).json({error:'Admin update failed.'});}});

// Socket authentication and realtime events
io.use(async(socket,next)=>{try{const supplied=socket.handshake.auth?.token;const cookie=socket.handshake.headers.cookie||'';const match=cookie.match(/(?:^|;\s*)chat_token=([^;]+)/);const t=supplied||decodeURIComponent(match?.[1]||'');if(!t)return next(new Error('Authentication required'));const p=jwt.verify(t,JWT_SECRET);const u=(await db('SELECT * FROM users WHERE id=$1',[p.id]))[0];if(!u||u.is_disabled)return next(new Error('Account unavailable'));socket.user=publicUser(u);socket.userId=u.id;next();}catch(e){next(new Error('Authentication failed'));}});

const online=new Map();
function joinUserRooms(socket){socket.join('user:'+socket.userId);for(const [sid,s] of online){if(s.userId!==socket.userId)io.to('user:'+s.userId).emit('presence',{userId:socket.userId,online:true});}}
function messagePayload(m){return {...m,created_at:m.created_at,edited_at:m.edited_at||null,deleted_at:m.deleted_at||null};}
async function createNotification(userId,type,title,body,data={}){const r=(await db('INSERT INTO notifications(user_id,type,title,body,data) VALUES($1,$2,$3,$4,$5) RETURNING *',[userId,type,title,body,JSON.stringify(data)]))[0];io.to('user:'+userId).emit('notification',r);return r;}

io.on('connection',socket=>{
 online.set(socket.id,socket);joinUserRooms(socket);socket.broadcast.emit('presence',{userId:socket.userId,online:true});
 db('UPDATE users SET last_seen=NOW() WHERE id=$1',[socket.userId]).catch(()=>{});
 socket.on('presence:ping',()=>db('UPDATE users SET last_seen=NOW() WHERE id=$1',[socket.userId]).catch(()=>{}));
 socket.on('conversation:join',async p=>{try{if(p?.type==='group'){const gid=Number(p.id);const ok=(await db('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,socket.userId]))[0];if(ok)socket.join('group:'+gid);}else{const id=Number(p?.id);if(await directAllowed(socket.userId,id)){socket.join('user:'+id);socket.join('user:'+socket.userId);}}}catch(e){}});
 socket.on('typing',p=>{if(p?.type==='group')io.to('group:'+Number(p.id)).emit('typing',{from:socket.userId,name:socket.user.displayName,active:!!p.active});else io.to('user:'+Number(p.to)).emit('typing',{from:socket.userId,name:socket.user.displayName,active:!!p.active});});
 socket.on('message:send',async(p,ack)=>{try{const body=String(p?.body||'').trim();const att=p?.attachment||null;if(!body&&!att)throw new Error('Message is empty');let row;if(p.type==='group'){const gid=Number(p.id);const member=(await db('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,socket.userId]))[0];if(!member)throw new Error('Not a group member');row=(await db(`INSERT INTO messages(sender_id,group_id,body,attachment_url,attachment_name,attachment_type,attachment_size) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[socket.userId,gid,body||null,att?.url||null,att?.name||null,att?.type||null,att?.size||null]))[0];const members=await db('SELECT user_id FROM group_members WHERE group_id=$1 AND user_id<>$2',[gid,socket.userId]);const sender=socket.user.displayName;io.to('group:'+gid).emit('message:new',messagePayload({...row,sender_name:sender,sender_avatar:socket.user.avatarUrl,is_read:false}));for(const m of members){await createNotification(m.user_id,'message',`New message in ${p.name||'group'}`,body||att?.name||'Attachment',{type:'group',id:gid});}}else{const to=Number(p.to);if(!(await directAllowed(socket.userId,to)))throw new Error('Recipient unavailable');row=(await db(`INSERT INTO messages(sender_id,receiver_id,body,attachment_url,attachment_name,attachment_type,attachment_size) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[socket.userId,to,body||null,att?.url||null,att?.name||null,att?.type||null,att?.size||null]))[0];const full={...row,sender_name:socket.user.displayName,sender_avatar:socket.user.avatarUrl,is_read:false};io.to('user:'+to).emit('message:new',messagePayload(full));io.to('user:'+socket.userId).emit('message:new',messagePayload(full));await createNotification(to,'message',`Message from ${socket.user.displayName}`,body||att?.name||'Attachment',{type:'direct',id:socket.userId});}ack?.({ok:true,message:row});}catch(e){ack?.({ok:false,error:e.message||'Could not send message'});}});
 socket.on('message:read',async p=>{try{const id=Number(p.messageId);const m=(await db('SELECT * FROM messages WHERE id=$1',[id]))[0];if(!m)return;if(m.receiver_id!==socket.userId && m.group_id==null)return;if(m.group_id){const ok=(await db('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[m.group_id,socket.userId]))[0];if(!ok)return;}await db('INSERT INTO message_reads(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,socket.userId]);const payload={messageId:id,userId:socket.userId,readAt:new Date().toISOString()};if(m.group_id)io.to('group:'+m.group_id).emit('message:read',payload);else{io.to('user:'+m.sender_id).emit('message:read',payload);io.to('user:'+socket.userId).emit('message:read',payload);}}catch(e){}});
 // Calling: signaling only. Media stays peer-to-peer via WebRTC.
 socket.on('call:invite',p=>io.to('user:'+Number(p.to)).emit('call:invite',{from:socket.userId,fromName:socket.user.displayName,fromAvatar:socket.user.avatarUrl,callType:p.callType,callId:p.callId}));
 socket.on('call:offer',p=>io.to('user:'+Number(p.to)).emit('call:offer',{from:socket.userId,fromName:socket.user.displayName,callType:p.callType,offer:p.offer,callId:p.callId}));
 socket.on('call:answer',p=>io.to('user:'+Number(p.to)).emit('call:answer',{from:socket.userId,answer:p.answer,callId:p.callId}));
 socket.on('call:ice',p=>io.to('user:'+Number(p.to)).emit('call:ice',{from:socket.userId,candidate:p.candidate,callId:p.callId}));
 socket.on('call:end',p=>io.to('user:'+Number(p.to)).emit('call:end',{from:socket.userId,callId:p.callId}));
 socket.on('disconnect',()=>{online.delete(socket.id);db('UPDATE users SET last_seen=NOW() WHERE id=$1',[socket.userId]).catch(()=>{});setTimeout(()=>{const still=[...online.values()].some(s=>s.userId===socket.userId);if(!still)io.emit('presence',{userId:socket.userId,online:false});},500);});
});

(async()=>{try{await initDb();server.listen(PORT,'0.0.0.0',()=>console.log(`ChatSpace V5 listening on ${PORT}`));}catch(e){console.error('Startup failed',e);process.exit(1);}})();
