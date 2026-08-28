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
const io=new Server(server,{transports:['websocket','polling'],pingInterval:25000,pingTimeout:20000,cors:{origin:true,credentials:true},maxHttpBufferSize:2e6});
const PORT=Number(process.env.PORT)||10000;
const JWT_SECRET=process.env.JWT_SECRET||'dev-secret-change-me';
const MAX_FILE_MB=Math.max(1,Math.min(50,Number(process.env.MAX_FILE_MB)||15));
const uploadDir=process.env.UPLOAD_DIR||path.join(__dirname,'uploads');
fs.mkdirSync(uploadDir,{recursive:true});
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false});
const db=(q,p=[])=>pool.query(q,p).then(r=>r.rows);

app.use(express.json({limit:'2mb'})); app.use(cookieParser()); app.use(express.static(path.join(__dirname,'public'))); app.use('/uploads',express.static(uploadDir));
app.get('/health',(req,res)=>res.json({ok:true,service:'chatspace-advanced',time:new Date().toISOString()}));

async function initDb(){
 if(!process.env.DATABASE_URL){console.warn('DATABASE_URL is not set.');return;}
 await db(`
 CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,username VARCHAR(40) UNIQUE NOT NULL,display_name VARCHAR(80) NOT NULL,password_hash TEXT NOT NULL,avatar_url TEXT,role VARCHAR(20) NOT NULL DEFAULT 'user',is_disabled BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_seen TIMESTAMPTZ);
 CREATE TABLE IF NOT EXISTS messages(id BIGSERIAL PRIMARY KEY,sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,group_id BIGINT,body TEXT,attachment_url TEXT,attachment_name TEXT,attachment_type TEXT,attachment_size BIGINT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),edited_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ);
 CREATE TABLE IF NOT EXISTS groups(id BIGSERIAL PRIMARY KEY,name VARCHAR(100) NOT NULL,description TEXT,avatar_url TEXT,owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS group_members(group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,role VARCHAR(20) NOT NULL DEFAULT 'member',joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(group_id,user_id));
 CREATE TABLE IF NOT EXISTS message_reads(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(message_id,user_id));
 CREATE TABLE IF NOT EXISTS notifications(id BIGSERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,type VARCHAR(30) NOT NULL,title VARCHAR(160) NOT NULL,body TEXT,read_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 ALTER TABLE messages ALTER COLUMN receiver_id DROP NOT NULL;
 ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_body_check;
 ALTER TABLE messages ALTER COLUMN body DROP NOT NULL;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_id BIGINT;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS body TEXT;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type TEXT;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_size BIGINT;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
 ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';
 ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT false;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
 CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id,receiver_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at DESC);
 `);
 if(process.env.ADMIN_USERNAME){await db('UPDATE users SET role=\'admin\' WHERE username=$1',[String(process.env.ADMIN_USERNAME).toLowerCase()]);}
}

function publicUser(u){return {id:u.id,username:u.username,displayName:u.display_name,avatarUrl:u.avatar_url||null,role:u.role,isDisabled:!!u.is_disabled,lastSeen:u.last_seen};}
function tokenFor(u){return jwt.sign({id:u.id,username:u.username,displayName:u.display_name,role:u.role},JWT_SECRET,{expiresIn:'7d'});}
function getToken(req){return req.cookies.chat_token;}
async function auth(req,res,next){try{const t=getToken(req);if(!t)throw 0;const p=jwt.verify(t,JWT_SECRET);const rows=await db('SELECT * FROM users WHERE id=$1',[p.id]);if(!rows[0]||rows[0].is_disabled)return res.status(403).json({error:'Account disabled or unavailable.'});req.user=rows[0];next();}catch(e){return res.status(401).json({error:'Not authenticated.'});}}
function admin(req,res,next){if(req.user?.role!=='admin')return res.status(403).json({error:'Admin access required.'});next();}
function setAuth(res,t){res.cookie('chat_token',t,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*86400000});}
function safeName(s){return String(s||'file').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120)||'file';}
const storage=multer.diskStorage({destination:uploadDir,filename:(req,file,cb)=>cb(null,Date.now()+'-'+crypto.randomBytes(6).toString('hex')+'-'+safeName(file.originalname))});
const upload=multer({storage,limits:{fileSize:MAX_FILE_MB*1024*1024}});

app.post('/api/register',async(req,res)=>{try{const username=String(req.body.username||'').trim().toLowerCase(),displayName=String(req.body.displayName||'').trim(),password=String(req.body.password||'');if(!/^[a-z0-9_]{3,40}$/.test(username))return res.status(400).json({error:'Username must be 3-40 characters.'});if(displayName.length<2||displayName.length>80)return res.status(400).json({error:'Display name must be 2-80 characters.'});if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters.'});if((await db('SELECT id FROM users WHERE username=$1',[username])).length)return res.status(409).json({error:'Username already exists.'});const role=process.env.ADMIN_USERNAME?.toLowerCase()===username?'admin':'user';const hash=await bcrypt.hash(password,12);const rows=await db('INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING *',[username,displayName,hash,role]);const t=tokenFor(rows[0]);setAuth(res,t);res.json({user:publicUser(rows[0]),socketToken:t});}catch(e){console.error(e);res.status(500).json({error:'Registration failed.'});}});
app.post('/api/login',async(req,res)=>{try{const username=String(req.body.username||'').trim().toLowerCase(),password=String(req.body.password||'');const r=await db('SELECT * FROM users WHERE username=$1',[username]);if(!r[0]||!(await bcrypt.compare(password,r[0].password_hash)))return res.status(401).json({error:'Invalid username or password.'});if(r[0].is_disabled)return res.status(403).json({error:'This account is disabled.'});const t=tokenFor(r[0]);setAuth(res,t);await db('UPDATE users SET last_seen=NOW() WHERE id=$1',[r[0].id]);res.json({user:publicUser(r[0]),socketToken:t});}catch(e){console.error(e);res.status(500).json({error:'Login failed.'});}});
app.post('/api/logout',(req,res)=>{res.clearCookie('chat_token');res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>res.json({user:publicUser(req.user)}));
app.get('/api/socket-token',auth,(req,res)=>res.json({socketToken:tokenFor(req.user)}));
app.get('/api/users',auth,async(req,res)=>{const q=String(req.query.q||'').trim().toLowerCase();const rows=await db(q?'SELECT * FROM users WHERE id<>$1 AND is_disabled=false AND (username ILIKE $2 OR display_name ILIKE $2) ORDER BY display_name LIMIT 50':'SELECT * FROM users WHERE id<>$1 AND is_disabled=false ORDER BY display_name LIMIT 50',[req.user.id,...(q?[`%${q}%`]:[])]);res.json({users:rows.map(publicUser)});});

app.get('/api/conversations',auth,async(req,res)=>{const r=await db(`SELECT u.*,m.id last_id,m.body last_body,m.attachment_name last_attachment,m.created_at last_at FROM users u LEFT JOIN LATERAL(SELECT * FROM messages WHERE group_id IS NULL AND ((sender_id=$1 AND receiver_id=u.id) OR(sender_id=u.id AND receiver_id=$1)) ORDER BY created_at DESC LIMIT 1)m ON true WHERE u.id<>$1 AND u.is_disabled=false ORDER BY m.created_at DESC NULLS LAST,u.display_name`,[req.user.id]);const g=await db(`SELECT g.*,m.body last_body,m.attachment_name last_attachment,m.created_at last_at FROM groups g JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=$1 LEFT JOIN LATERAL(SELECT * FROM messages WHERE group_id=g.id ORDER BY created_at DESC LIMIT 1)m ON true ORDER BY m.created_at DESC NULLS LAST,g.name`,[req.user.id]);res.json({conversations:r.map(x=>({...publicUser(x),type:'direct',lastMessage:x.last_body||x.last_attachment||'',lastAt:x.last_at})),groups:g.map(x=>({id:x.id,type:'group',name:x.name,description:x.description,avatarUrl:x.avatar_url,lastMessage:x.last_body||x.last_attachment||'',lastAt:x.last_at}))});});
app.get('/api/messages/direct/:userId',auth,async(req,res)=>{const id=Number(req.params.userId);const r=await db(`SELECT m.*,u.display_name sender_name,u.avatar_url sender_avatar,EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id=m.id AND mr.user_id=$1) is_read FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.group_id IS NULL AND((m.sender_id=$1 AND m.receiver_id=$2)OR(m.sender_id=$2 AND m.receiver_id=$1)) ORDER BY m.created_at LIMIT 1000`,[req.user.id,id]);res.json({messages:r});});
app.get('/api/messages/group/:groupId',auth,async(req,res)=>{const gid=Number(req.params.groupId);if(!(await db('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,req.user.id])).length)return res.status(403).json({error:'Not a group member.'});const r=await db(`SELECT m.*,u.display_name sender_name,u.avatar_url sender_avatar,EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id=m.id AND mr.user_id=$1) is_read FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.group_id=$2 ORDER BY m.created_at LIMIT 1000`,[req.user.id,gid]);res.json({messages:r});});

app.post('/api/profile',auth,upload.single('avatar'),async(req,res)=>{try{let url=req.user.avatar_url;if(req.file){if(!req.file.mimetype.startsWith('image/')){fs.unlinkSync(req.file.path);return res.status(400).json({error:'Profile photo must be an image.'});}url='/uploads/'+path.basename(req.file.path);}const name=String(req.body.displayName||req.user.display_name).trim().slice(0,80);const r=await db('UPDATE users SET display_name=$1,avatar_url=$2 WHERE id=$3 RETURNING *',[name,url,req.user.id]);res.json({user:publicUser(r[0])});}catch(e){console.error(e);res.status(500).json({error:'Profile update failed.'});}});
app.post('/api/upload',auth,upload.single('file'),async(req,res)=>{try{if(!req.file)return res.status(400).json({error:'No file selected.'});res.json({url:'/uploads/'+path.basename(req.file.path),name:req.file.originalname,type:req.file.mimetype,size:req.file.size});}catch(e){res.status(500).json({error:'Upload failed.'});}});

app.post('/api/groups',auth,async(req,res)=>{try{const name=String(req.body.name||'').trim();const ids=[...new Set((req.body.memberIds||[]).map(Number).filter(Number.isInteger).concat(req.user.id))];if(name.length<1||name.length>100)return res.status(400).json({error:'Group name is required.'});const g=(await db('INSERT INTO groups(name,description,owner_id) VALUES($1,$2,$3) RETURNING *',[name,String(req.body.description||'').slice(0,500),req.user.id]))[0];for(const uid of ids)await db('INSERT INTO group_members(group_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[g.id,uid,uid===req.user.id?'admin':'member']);res.json({group:g});}catch(e){console.error(e);res.status(500).json({error:'Could not create group.'});}});
app.get('/api/groups/:id',auth,async(req,res)=>{const gid=Number(req.params.id);const g=(await db('SELECT * FROM groups WHERE id=$1',[gid]))[0];if(!g)return res.status(404).json({error:'Group not found.'});if(!(await db('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,req.user.id])).length)return res.status(403).json({error:'Not a member.'});const members=await db('SELECT u.*,gm.role group_role FROM users u JOIN group_members gm ON gm.user_id=u.id WHERE gm.group_id=$1 ORDER BY u.display_name',[gid]);res.json({group:g,members:members.map(publicUser)});});
app.post('/api/groups/:id/members',auth,async(req,res)=>{const gid=Number(req.params.id),uids=(req.body.userIds||[]).map(Number).filter(Number.isInteger);const gm=(await db('SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,req.user.id]))[0];if(!gm||gm.role!=='admin')return res.status(403).json({error:'Group admin required.'});for(const uid of uids)await db('INSERT INTO group_members(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[gid,uid]);res.json({ok:true});});
app.delete('/api/groups/:id/members/:userId',auth,async(req,res)=>{const gid=Number(req.params.id),uid=Number(req.params.userId);const gm=(await db('SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2',[gid,req.user.id]))[0];if(!gm||gm.role!=='admin')return res.status(403).json({error:'Group admin required.'});await db('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2 AND user_id<>$3',[gid,uid,req.user.id]);res.json({ok:true});});

app.post('/api/messages/:id/edit',auth,async(req,res)=>{const id=BigInt(req.params.id),body=String(req.body.body||'').trim();const r=await db('UPDATE messages SET body=$1,edited_at=NOW() WHERE id=$2 AND sender_id=$3 AND deleted_at IS NULL RETURNING *',[body,id,req.user.id]);if(!r[0])return res.status(404).json({error:'Message not found.'});broadcastMessage('message_updated',r[0]);res.json({message:r[0]});});
app.delete('/api/messages/:id',auth,async(req,res)=>{const id=BigInt(req.params.id);const r=await db('UPDATE messages SET body=NULL,attachment_url=NULL,attachment_name=NULL,attachment_type=NULL,attachment_size=NULL,deleted_at=NOW() WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL RETURNING *',[id,req.user.id]);if(!r[0])return res.status(404).json({error:'Message not found.'});broadcastMessage('message_deleted',r[0]);res.json({message:r[0]});});
app.post('/api/messages/:id/read',auth,async(req,res)=>{const id=BigInt(req.params.id);await db('INSERT INTO message_reads(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,req.user.id]);const r=(await db('SELECT * FROM messages WHERE id=$1',[id]))[0];if(r){if(r.group_id)notifyGroupRead(r);else io.to('user:'+r.sender_id).emit('message_read',{messageId:String(r.id),userId:req.user.id,readAt:new Date().toISOString()});}res.json({ok:true});});

app.get('/api/notifications',auth,async(req,res)=>{const r=await db('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[req.user.id]);res.json({notifications:r});});
app.post('/api/notifications/read',auth,async(req,res)=>{await db('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL',[req.user.id]);res.json({ok:true});});

app.get('/api/admin/stats',auth,admin,async(req,res)=>{const [u,m,g]=await Promise.all([db('SELECT COUNT(*) c FROM users'),db('SELECT COUNT(*) c FROM messages'),db('SELECT COUNT(*) c FROM groups')]);res.json({users:Number(u[0].c),messages:Number(m[0].c),groups:Number(g[0].c)});});
app.get('/api/admin/users',auth,admin,async(req,res)=>{const r=await db('SELECT id,username,display_name,avatar_url,role,is_disabled,created_at,last_seen FROM users ORDER BY created_at DESC');res.json({users:r.map(publicUser)});});
app.patch('/api/admin/users/:id',auth,admin,async(req,res)=>{const id=Number(req.params.id);if(id===req.user.id&&req.body.isDisabled)return res.status(400).json({error:'You cannot disable yourself.'});const role=req.body.role==='admin'?'admin':'user';const disabled=!!req.body.isDisabled;const r=await db('UPDATE users SET role=$1,is_disabled=$2 WHERE id=$3 RETURNING *',[role,disabled,id]);if(!r[0])return res.status(404).json({error:'User not found.'});res.json({user:publicUser(r[0])});});

function broadcastMessage(event,m){const msg={...m,id:String(m.id)};if(m.group_id)io.to('group:'+m.group_id).emit(event,msg);else{io.to('user:'+m.sender_id).emit(event,msg);io.to('user:'+m.receiver_id).emit(event,msg);}}
async function notifyGroupRead(m){const members=await db('SELECT user_id FROM group_members WHERE group_id=$1',[m.group_id]);io.to('group:'+m.group_id).emit('message_read',{messageId:String(m.id),userId:m.sender_id,readAt:new Date().toISOString()});}
async function createNotification(userId,title,body){const r=await db('INSERT INTO notifications(user_id,type,title,body) VALUES($1,$2,$3,$4) RETURNING *',[userId,'message',title,body]);io.to('user:'+userId).emit('notification',r[0]);}

io.use((socket,next)=>{try{const t=socket.handshake.auth?.token||socket.handshake.headers?.cookie?.match(/chat_token=([^;]+)/)?.[1];if(!t)throw 0;socket.user=jwt.verify(t,JWT_SECRET);next();}catch(e){next(new Error('Unauthorized'));}});
const online=new Map();
io.on('connection',async socket=>{const u=socket.user;socket.join('user:'+u.id);online.set(u.id,(online.get(u.id)||0)+1);io.emit('presence',{userId:u.id,online:true});
 socket.on('join_group',async gid=>{const ok=await db('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[Number(gid),u.id]);if(ok.length)socket.join('group:'+Number(gid));});
 socket.on('send_message',async(p,cb)=>{try{const body=String(p.body||'').trim();const receiver=p.receiverId?Number(p.receiverId):null;const group=p.groupId?Number(p.groupId):null;const attachment=p.attachment||null;if(!receiver&&!group)throw Error('Choose a recipient or group.');if(!body&&!attachment)throw Error('Message cannot be empty.');if(body.length>4000)throw Error('Message is too long.');if(group&&!(await db('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[group,u.id])).length)throw Error('Not a group member.');if(receiver&&!(await db('SELECT 1 FROM users WHERE id=$1 AND is_disabled=false',[receiver])).length)throw Error('Recipient not found.');const r=(await db(`INSERT INTO messages(sender_id,receiver_id,group_id,body,attachment_url,attachment_name,attachment_type,attachment_size) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[u.id,receiver,group,body||null,attachment?.url||null,attachment?.name||null,attachment?.type||null,attachment?.size||null]))[0];broadcastMessage('new_message',r);if(receiver){await createNotification(receiver,u.displayName||u.username,body||attachment.name||'Sent a file');}else{const members=await db('SELECT user_id FROM group_members WHERE group_id=$1 AND user_id<>$2',[group,u.id]);for(const x of members)await createNotification(x.user_id,'New group message',body||attachment.name||'Sent a file');}cb?.({ok:true,message:r});}catch(e){cb?.({ok:false,error:e.message||'Send failed'});}});
 socket.on('typing',p=>{const target=p.receiverId?'user:'+Number(p.receiverId):p.groupId?'group:'+Number(p.groupId):null;if(target)socket.to(target).emit('typing',{userId:u.id,typing:!!p.typing});});
 socket.on('call:offer',p=>{const target=p.groupId?'group:'+Number(p.groupId):'user:'+Number(p.to);socket.to(target).emit('call:offer',{from:u.id,fromName:u.displayName,offer:p.offer,callType:p.callType||'video'});});
 socket.on('call:answer',p=>socket.to('user:'+Number(p.to)).emit('call:answer',{from:u.id,answer:p.answer}));
 socket.on('call:ice',p=>socket.to('user:'+Number(p.to)).emit('call:ice',{from:u.id,candidate:p.candidate}));
 socket.on('call:end',p=>socket.to('user:'+Number(p.to)).emit('call:end',{from:u.id}));
 socket.on('disconnect',async()=>{const n=Math.max(0,(online.get(u.id)||1)-1);if(n)online.set(u.id,n);else{online.delete(u.id);await db('UPDATE users SET last_seen=NOW() WHERE id=$1',[u.id]);io.emit('presence',{userId:u.id,online:false});}});
});

(async()=>{try{await initDb();server.listen(PORT,'0.0.0.0',()=>console.log('ChatSpace Advanced listening on '+PORT));}catch(e){console.error('Startup failed',e);process.exit(1);}})();
