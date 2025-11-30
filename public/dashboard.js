// AUTH CHECK
const urlParams = new URLSearchParams(window.location.search);
const tokenFromUrl = urlParams.get('token');
if (tokenFromUrl) { localStorage.setItem('authToken', tokenFromUrl); window.history.replaceState({}, '', "/dashboard.html"); }
const token = localStorage.getItem('authToken');
if (!token) window.location.replace('index.html');

// VARIABLES
let clients = [], importedClients = [], promos = [];
let selectedPromoId = null, socket = null, isWhatsappReady = false;
let isCampaignRunning = false, globalSuccessCount = 0, globalFailCount = 0;
let validNumbersBuffer = [];

// UI ELEMENTS
const uiElements = {
    logoutBtn: document.getElementById('logoutBtn'),
    statusMessage: document.getElementById('status-message'),
    statusDisplay: document.getElementById('status-message-display'),
    qrcodeCanvas: document.getElementById('qrcode-canvas'),
    disconnectBtn: document.getElementById('disconnectWhatsappBtn'),
    
    clientsList: document.getElementById('clientsList'),
    importedList: document.getElementById('importedClientsList'),
    promosList: document.getElementById('promosList'),
    logsContainer: document.getElementById('logs'),
    
    csvFile: document.getElementById('csvFileInput'),
    importBtn: document.getElementById('importCsvBtn'),
    
    filterInput: document.getElementById('filterInput'),
    filterFile: document.getElementById('filterFileInput'),
    btnUploadFilter: document.getElementById('btnUploadFilter'),
    startFilterBtn: document.getElementById('startFilterBtn'),
    stopFilterBtn: document.getElementById('stopFilterBtn'),
    exportValidBtn: document.getElementById('exportValidBtn'),
    listValid: document.getElementById('listValid'),
    listInvalid: document.getElementById('listInvalid'),
    countValid: document.getElementById('countValid'),
    countInvalid: document.getElementById('countInvalid'),
    filterStatus: document.getElementById('filterStatus')
};

// INIT
document.addEventListener('DOMContentLoaded', () => {
    initListeners();
    initSocket();
    loadData();
});

function initListeners() {
    // Tabs
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => switchTab(item.dataset.tab));
    });

    // Main Actions
    uiElements.logoutBtn.onclick = () => logout();
    uiElements.importBtn.onclick = importCSV;
    uiElements.disconnectBtn.onclick = () => { if(confirm("Logout from WhatsApp?")) socket.emit('logout-whatsapp'); };

    // Promo Actions
    document.getElementById('addNewPromoBtn').onclick = addPromo;
    document.getElementById('sendSequentiallyClientsBtn').onclick = () => startCampaign(clients, false);
    document.getElementById('sendSequentiallyImportedBtn').onclick = () => startCampaign(importedClients, true);
    document.getElementById('sendSelectedPromoBtn').onclick = sendSingle;
    document.getElementById('deleteAllImportedBtn').onclick = deleteImported;
    document.getElementById('exportClientsBtn').onclick = exportClients;
    document.getElementById('savePromptBtn').onclick = saveBotSettings;
    document.getElementById('syncContactsBtn').onclick = () => { socket.emit('sync-contacts'); log("Syncing...", "blue"); };

    // Filter Actions
    uiElements.startFilterBtn.onclick = startFilter;
    uiElements.stopFilterBtn.onclick = stopFilter;
    uiElements.exportValidBtn.onclick = exportValid;
    uiElements.btnUploadFilter.onclick = () => uiElements.filterFile.click();
    
    uiElements.filterFile.onchange = (e) => {
        const file = e.target.files[0];
        if(!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            uiElements.filterInput.value = ev.target.result.replace(/[^\d\n]/g, '');
            uiElements.filterFile.value = '';
        };
        reader.readAsText(file);
    };
}

function switchTab(tab) {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`.nav-item[data-tab="${tab}"]`).classList.add('active');
    document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active-section'));
    document.getElementById(`tab-${tab}`).classList.add('active-section');
}

// SOCKET
function initSocket() {
    socket = io({ auth: { token } });

    socket.on('connect', () => { log('Connected to server', 'blue'); socket.emit('init-whatsapp', token); });
    
    socket.on('qr', (qr) => {
        isWhatsappReady = false;
        uiElements.statusMessage.innerText = "Scan QR";
        uiElements.statusDisplay.innerText = "Scan QR Code Below";
        uiElements.qrcodeCanvas.style.display = 'block';
        uiElements.disconnectBtn.style.display = 'none';
        QRCode.toCanvas(uiElements.qrcodeCanvas, qr, {width:256});
    });

    socket.on('status', (s) => {
        uiElements.statusDisplay.innerText = s.message;
        if(s.ready) {
            isWhatsappReady = true;
            uiElements.statusMessage.innerText = "Connected";
            uiElements.statusMessage.style.color = "#00d26a";
            uiElements.qrcodeCanvas.style.display = 'none';
            uiElements.disconnectBtn.style.display = 'inline-block';
            loadData();
            log("WhatsApp Ready", "green");
        } else {
            isWhatsappReady = false;
            uiElements.disconnectBtn.style.display = 'none';
        }
    });

    socket.on('whatsapp-logged-out', () => {
        isWhatsappReady = false;
        uiElements.statusDisplay.innerText = "Logged Out";
        clients = []; importedClients = [];
        renderLists();
        socket.emit('init-whatsapp', token);
    });

    // Filter Events
    socket.on('filter-result', (d) => {
        const div = document.createElement('div'); div.innerText = d.phone;
        if(d.status === 'valid') {
            div.style.color = '#4ade80';
            uiElements.listValid.appendChild(div);
            validNumbersBuffer.push(d.phone);
            uiElements.countValid.innerText = validNumbersBuffer.length;
            uiElements.exportValidBtn.disabled = false;
            uiElements.exportValidBtn.classList.replace('btn-secondary', 'btn-success');
        } else {
            div.style.color = '#f87171';
            uiElements.listInvalid.appendChild(div);
            uiElements.countInvalid.innerText = parseInt(uiElements.countInvalid.innerText)+1;
        }
    });

    socket.on('filter-complete', () => { resetFilterUI(); uiElements.filterStatus.innerText = "Done."; });
    socket.on('filter-stopped', () => { resetFilterUI(); uiElements.filterStatus.innerText = "Stopped."; log("Filter stopped", "orange"); });
    socket.on('filter-error', (m) => { alert(m); resetFilterUI(); });
    
    socket.on('send-promo-status', (s) => {
        if(s.success) { globalSuccessCount++; log(`Sent: ${s.phone}`, 'green'); }
        else { globalFailCount++; log(`Failed: ${s.phone}`, 'red'); }
        updateStats();
    });

    socket.on('sync-complete', () => { log("Contacts Synced", "green"); loadClients(); });
    socket.on('log', (d) => log(d.message, d.color));
}

// ACTIONS
async function importCSV() {
    const file = uiElements.csvFile.files[0];
    if(!file) return alert("Select CSV");
    
    uiElements.importBtn.disabled = true;
    uiElements.importBtn.innerText = "Uploading...";
    
    const fd = new FormData(); fd.append('csv', file);
    try {
        const res = await api('/import-csv', 'POST', fd);
        if(res.imported) { 
            alert(`Imported ${res.imported} numbers`); 
            uiElements.csvFile.value = ''; 
            loadImportedClients(); 
        }
    } catch(e) { alert(e.message); }
    finally { uiElements.importBtn.disabled = false; uiElements.importBtn.innerText = "Upload"; }
}

function startFilter() {
    const nums = uiElements.filterInput.value;
    if(!nums) return alert("Enter numbers");
    
    validNumbersBuffer = [];
    uiElements.listValid.innerHTML = '';
    uiElements.listInvalid.innerHTML = '';
    uiElements.countValid.innerText = '0';
    uiElements.countInvalid.innerText = '0';
    uiElements.filterStatus.innerText = "Running...";
    
    uiElements.startFilterBtn.style.display = 'none';
    uiElements.stopFilterBtn.style.display = 'inline-block';
    uiElements.exportValidBtn.disabled = true;
    
    socket.emit('check-numbers', { numbers: nums });
}

function stopFilter() {
    if(confirm("Stop?")) {
        uiElements.stopFilterBtn.innerText = "Stopping...";
        socket.emit('stop-filter');
    }
}

function resetFilterUI() {
    uiElements.startFilterBtn.style.display = 'inline-block';
    uiElements.stopFilterBtn.style.display = 'none';
    uiElements.stopFilterBtn.innerText = "Stop";
    if(validNumbersBuffer.length > 0) uiElements.exportValidBtn.disabled = false;
}

function exportValid() {
    const csv = "Phone\n" + validNumbersBuffer.join("\n");
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    a.download = `valid_${Date.now()}.csv`;
    a.click();
}

// DATA & HELPERS
async function api(url, method='GET', body=null) {
    const headers = { 'Authorization': `Bearer ${token}` };
    if(body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body instanceof FormData ? body : JSON.stringify(body) });
    if(res.status === 401) logout();
    return res.json();
}

async function loadData() { loadClients(); loadImportedClients(); loadPromos(); }
async function loadClients() { clients = await api('/contacts'); renderLists(); }
async function loadImportedClients() { importedClients = await api('/imported-contacts'); renderLists(); }
async function loadPromos() { promos = await api('/promos'); renderPromos(); }

function renderLists() {
    uiElements.clientsList.innerHTML = clients.map(c => `<div style="padding:5px; border-bottom:1px solid #333">${c.name} (+${c.phone})</div>`).join('');
    uiElements.importedList.innerHTML = importedClients.map(c => `<div style="padding:5px; border-bottom:1px solid #333">+${c.phone}</div>`).join('');
    document.getElementById('stat-total-contacts').innerText = clients.length + importedClients.length;
}

function renderPromos() {
    uiElements.promosList.innerHTML = promos.map(p => `
        <div class="promo" id="p-${p.id}">
            ${p.image ? `<img src="promos/${p.image}">` : ''}
            <p>${p.text}</p>
            <button onclick="selectPromo(${p.id})">Select</button>
            <button onclick="deletePromo(${p.id})">Delete</button>
        </div>`).join('');
}

function selectPromo(id) { 
    selectedPromoId = id; 
    document.querySelectorAll('.promo').forEach(p => p.style.borderColor = '#2d3748');
    document.getElementById(`p-${id}`).style.borderColor = '#00d26a';
}

async function addPromo() {
    const txt = document.getElementById('newPromoText').value;
    const img = document.getElementById('newPromoImage').files[0];
    const fd = new FormData(); fd.append('text', txt); if(img) fd.append('image', img);
    await api('/addPromo', 'POST', fd);
    loadPromos();
}

window.deletePromo = async (id) => { if(confirm("Delete?")) { await api(`/deletePromo/${id}`, 'DELETE'); loadPromos(); } };
async function deleteImported() { if(confirm("Clear list?")) { await api('/api/delete-all-imported', 'DELETE'); loadImportedClients(); } }

function startCampaign(list, isImported) {
    if(!isWhatsappReady) return alert("Not Connected");
    if(!selectedPromoId) return alert("Select Promo");
    if(!list.length) return alert("Empty List");
    
    socket.emit('start-campaign-mode', { promoId: selectedPromoId });
    isCampaignRunning = true;
    
    // Simple Sequential Loop
    (async () => {
        for(const c of list) {
            if(!isWhatsappReady) break;
            socket.emit('send-promo', { phone: c.phone, promoId: selectedPromoId, fromImported: isImported });
            await new Promise(r => setTimeout(r, Math.random() * 5000 + 5000));
        }
        isCampaignRunning = false;
        alert("Campaign Finished");
    })();
}

function sendSingle() {
    const p = document.getElementById('phoneInput').value;
    if(p && selectedPromoId) socket.emit('send-promo', { phone: p, promoId: selectedPromoId, fromImported: false });
}

function logout() {
    localStorage.removeItem('authToken');
    window.location = 'index.html';
}

function updateStats() {
    document.getElementById('stat-sent-success').innerText = globalSuccessCount;
    document.getElementById('stat-sent-failed').innerText = globalFailCount;
}

function log(m, c) { 
    const d = document.createElement('div'); 
    d.innerText = `[${new Date().toLocaleTimeString()}] ${m}`; 
    d.style.color = c; 
    uiElements.logsContainer.prepend(d); 
}

// Extras
async function saveChatbotPrompt() { 
    await api('/api/chatbot-prompt', 'POST', { prompt: document.getElementById('chatbotPrompt').value }); 
    alert("Saved"); 
}
