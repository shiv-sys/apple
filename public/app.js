let me = null;
let users = [];
let activeUser = null;
let socket = null;
let socketToken = null;
let authMode = "login";
const onlineUsers = new Set();

const $ = id => document.getElementById(id);

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.className = "show";
  setTimeout(() => el.className = "", 2200);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {"Content-Type":"application/json", ...(options.headers || {})}
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function initials(name) {
  return name.split(/\s+/).map(x => x[0]).join("").slice(0,2).toUpperCase();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.mode === mode));
  $("displayNameWrap").classList.toggle("hidden", mode !== "register");
  $("authSubmit").textContent = mode === "register" ? "Create account" : "Login";
  $("authError").textContent = "";
}

document.querySelectorAll(".tab").forEach(t => t.onclick = () => setAuthMode(t.dataset.mode));

$("authForm").onsubmit = async e => {
  e.preventDefault();
  $("authError").textContent = "";
  try {
    const endpoint = authMode === "register" ? "/api/register" : "/api/login";
    const body = {
      username: $("username").value,
      password: $("password").value
    };
    if (authMode === "register") body.displayName = $("displayName").value;

    const data = await api(endpoint, {method:"POST", body:JSON.stringify(body)});
    me = data.user;
    socketToken = data.socketToken;
    showApp();
  } catch (err) {
    $("authError").textContent = err.message;
  }
};

async function bootstrap() {
  try {
    const data = await api("/api/me");
    me = data.user;
    const tokenData = await api("/api/socket-token");
    socketToken = tokenData.socketToken;
    showApp();
  } catch {
    $("authView").classList.remove("hidden");
  }
}

async function showApp() {
  $("authView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("myName").textContent = `Signed in as ${me.displayName}`;
  connectSocket();
  await loadPeople();
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({
    auth: { token: socketToken },
    withCredentials: true,
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    timeout: 10000
  });

  socket.on("connect", () => {
    toast("Realtime connected");
  });

  socket.on("connect_error", err => {
    console.error("Socket.IO connection error:", err);
    toast("Realtime connection unavailable — retrying...");
  });
  socket.on("presence", ({userId, online}) => {
    if (online) onlineUsers.add(userId);
    else onlineUsers.delete(userId);
    renderPeople();
    if (activeUser && activeUser.id === userId) updateStatus();
  });

  socket.on("typing", ({userId, typing}) => {
    if (activeUser?.id === userId) {
      $("chatStatus").textContent = typing ? "typing..." : (onlineUsers.has(userId) ? "online" : "offline");
    }
  });

  socket.on("new_message", msg => {
    if (activeUser && (msg.sender_id === activeUser.id || msg.receiver_id === activeUser.id)) {
      appendMessage(msg);
      scrollMessages();
    }
    loadPeople();
  });
}

async function loadPeople(q = "") {
  try {
    const data = await api("/api/users" + (q ? `?q=${encodeURIComponent(q)}` : ""));
    users = data.users;
    renderPeople();
  } catch (e) {
    toast(e.message);
  }
}

function renderPeople() {
  const list = $("peopleList");
  if (!users.length) {
    list.innerHTML = `<div class="empty-state" style="padding:35px 15px"><p>No people found.</p></div>`;
    return;
  }

  list.innerHTML = users.map(u => `
    <button class="person ${activeUser?.id === u.id ? "selected" : ""}" data-id="${u.id}">
      <div class="avatar">${initials(u.displayName)}</div>
      <div class="person-info">
        <div class="person-name">${escapeHtml(u.displayName)}</div>
        <div class="person-last">@${escapeHtml(u.username)}</div>
      </div>
      ${onlineUsers.has(u.id) ? '<span class="online-dot"></span>' : ''}
    </button>
  `).join("");

  list.querySelectorAll(".person").forEach(btn => {
    btn.onclick = () => openChat(Number(btn.dataset.id));
  });
}

async function openChat(id) {
  activeUser = users.find(u => u.id === id) || null;
  if (!activeUser) return;

  document.querySelector(".app-shell").classList.add("chat-open");
  $("chatAvatar").textContent = initials(activeUser.displayName);
  $("chatName").textContent = activeUser.displayName;
  $("composer").classList.remove("hidden");
  updateStatus();
  renderPeople();

  $("messages").innerHTML = "";
  try {
    const data = await api(`/api/messages/${id}`);
    data.messages.forEach(appendMessage);
    scrollMessages();
  } catch (e) {
    toast(e.message);
  }
}

function updateStatus() {
  $("chatStatus").textContent = activeUser && onlineUsers.has(activeUser.id) ? "online" : "offline";
}

function appendMessage(msg) {
  const mine = msg.sender_id === me.id;
  const row = document.createElement("div");
  row.className = `bubble ${mine ? "mine" : "theirs"}`;
  const date = new Date(msg.created_at);
  row.innerHTML = `${escapeHtml(msg.body).replace(/\n/g,"<br>")}<span class="time">${date.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</span>`;
  $("messages").appendChild(row);
}

function scrollMessages() {
  $("messages").scrollTop = $("messages").scrollHeight;
}

$("composer").onsubmit = e => {
  e.preventDefault();
  const input = $("messageInput");
  const body = input.value.trim();
  if (!body || !activeUser || !socket?.connected) return;

  socket.emit("send_message", {receiverId: activeUser.id, body}, result => {
    if (!result?.ok) toast(result?.error || "Message failed");
  });
  input.value = "";
  input.focus();
};

let typingTimer;
$("messageInput").addEventListener("input", () => {
  if (!activeUser || !socket?.connected) return;
  socket.emit("typing", {receiverId: activeUser.id, typing: true});
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit("typing", {receiverId: activeUser.id, typing: false});
  }, 700);
});

$("searchInput").oninput = e => loadPeople(e.target.value.trim());

$("backBtn").onclick = () => {
  document.querySelector(".app-shell").classList.remove("chat-open");
  activeUser = null;
  $("composer").classList.add("hidden");
};

$("logoutBtn").onclick = async () => {
  try { await api("/api/logout", {method:"POST"}); } catch {}
  location.reload();
};

bootstrap();
