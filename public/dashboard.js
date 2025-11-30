// ================================================================= //
// ============ 0. AUTHENTICATION ================================== //
// ================================================================= //
const urlParams = new URLSearchParams(window.location.search);
const tokenFromUrl = urlParams.get('token');
if (tokenFromUrl) {
    localStorage.setItem('authToken', tokenFromUrl);
    window.history.replaceState({}, document.title, "/dashboard.html");
}

const token = localStorage.getItem('authToken');
if (!token) {
    window.location.replace('index.html');
}

// ================================================================= //
// ======================== 1. GLOBAL VARIABLES ==================== //
// ================================================================= //
let clients = [];
let importedClients = [];
let promos = [];
let selectedPromoId = null;
let socket = null;
let isWhatsappReady = false;

let isCampaignRunning = false;
let globalSuccessCount = 0;
let globalFailCount = 0;
let validNumbersBuffer = [];

// عناصر الواجهة (تأكد أن الأسماء مطابقة لـ HTML)
const uiElements = {
    logoutBtn: document.getElementById('logoutBtn'),
    statusMessage: document.getElementById('status-message-display') || document.getElementById('status-message'),
    qrcodeCanvas: document.getElementById('qrcode-canvas'),
    disconnectWhatsappBtn: document.getElementById('disconnectWhatsappBtn'),
    
    // القوائم
    clientsList: document.getElementById('clientsList'),
    importedClientsList: document.getElementById('importedClientsList'),
    promosList: document.getElementById('promosList'),
    logsContainer: document.getElementById('logs'),
    
    // الاستيراد
    csvFileInput: document.getElementById('csvFileInput'),
    importCsvBtn: document.getElementById('importCsvBtn'),
    
    // الحملات
    sendSequentiallyClientsBtn: document.getElementById('sendSequentiallyClientsBtn'),
    sendSequentiallyImportedBtn: document.getElementById('sendSequentiallyImportedBtn'),
    deleteAllImportedBtn: document.getElementById('deleteAllImportedBtn'),
    exportClientsBtn: document.getElementById('exportClientsBtn'),
    
    // العروض
    newPromoText: document.getElementById('newPromoText'),
    newPromoImage: document.getElementById('newPromoImage'),
    addNewPromoBtn: document.getElementById('addNewPromoBtn'),
    generateSpintaxBtn: document.getElementById('generateSpintaxBtn'),
    
    // فردي
    phoneInput: document.getElementById('phoneInput'),
    sendSelectedPromoBtn: document.getElementById('sendSelectedPromoBtn'),
    
    // بوت
    chatbotPrompt: document.getElementById('chatbotPrompt'),
    savePromptBtn: document.getElementById('savePromptBtn'),
    syncContactsBtn: document.getElementById('syncContactsBtn'),
    chatbotStatusToggle: document.getElementById('chatbotStatusToggle'),
    
    // عدادات
    statSuccess: document.getElementById('stat-sent-success'),
    statFailed: document.getElementById('stat-sent-failed'),
    statTotal: document.getElementById('stat-total-contacts'),
    
    // فلتر
    filterInput: document.getElementById('filterInput'),
    startFilterBtn: document.getElementById('startFilterBtn'),
    stopFilterBtn: document.getElementById('stopFilterBtn'),
    exportValidBtn: document.getElementById('exportValidBtn'),
    listValid: document.getElementById('listValid'),
    listInvalid: document.getElementById('listInvalid'),
    countValid: document.getElementById('countValid'),
    countInvalid: document.getElementById('countInvalid'),
    filterStatus: document.getElementById('filterStatus'),
    filterFileInput: document.getElementById('filterFileInput'),
    btnUploadFilter: document.getElementById('btnUploadFilter')
};

// ================================================================= //
// ==================== 2. INITIALIZATION ========================== //
// ================================================================= //
document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    initializeWhatsAppConnection();
    loadInitialData(); // تحميل البيانات فوراً
    setupLogsObserver();
});

function initializeEventListeners() {
    // التنقل (Tabs)
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const tabName = item.getAttribute('data-tab');
            if (tabName) switchTab(tabName);
        });
    });

    // الأزرار الرئيسية
    if(uiElements.logoutBtn) uiElements.logoutBtn.addEventListener('click', () => handleLogout(false));
    if(uiElements.addNewPromoBtn) uiElements.addNewPromoBtn.addEventListener('click', addNewPromo);
    
    // زر الاستيراد (مهم)
    if (uiElements.importCsvBtn) {
        uiElements.importCsvBtn.addEventListener('click', importCSV);
    }
    
    if(uiElements.sendSequentiallyClientsBtn) uiElements.sendSequentiallyClientsBtn.addEventListener('click', () => { startNewCampaign(); sendPromoSequentially(clients, false); });
    if(uiElements.sendSequentiallyImportedBtn) uiElements.sendSequentiallyImportedBtn.addEventListener('click', () => { startNewCampaign(); sendPromoSequentially(importedClients, true); });
    if(uiElements.sendSelectedPromoBtn) uiElements.sendSelectedPromoBtn.addEventListener('click', () => { startNewCampaign(); sendSelectedPromo(); });

    if (uiElements.deleteAllImportedBtn) uiElements.deleteAllImportedBtn.addEventListener('click', deleteAllImported);
    if (uiElements.exportClientsBtn) uiElements.exportClientsBtn.addEventListener('click', exportClientsToCSV);
    if (uiElements.savePromptBtn) uiElements.savePromptBtn.addEventListener('click', saveChatbotPrompt);
    if (uiElements.syncContactsBtn) uiElements.syncContactsBtn.addEventListener('click', requestContactSync);
    if (uiElements.chatbotStatusToggle) uiElements.chatbotStatusToggle.addEventListener('change', toggleChatbotStatus);
    if (uiElements.generateSpintaxBtn) uiElements.generateSpintaxBtn.addEventListener('click', generateSpintax);

    // زر الفصل
    if (uiElements.disconnectWhatsappBtn) {
        uiElements.disconnectWhatsappBtn.addEventListener('click', () => {
            if(confirm("هل تريد فصل الرقم؟")) {
                if(socket) {
                    socket.emit('logout-whatsapp'); 
                    uiElements.statusMessage.innerText = "جاري الفصل...";
                    uiElements.disconnectWhatsappBtn.style.display = 'none';
                }
            }
        });
    }

    // الفلتر
    if (uiElements.startFilterBtn) uiElements.startFilterBtn.addEventListener('click', startNumberFilter);
    if (uiElements.stopFilterBtn) uiElements.stopFilterBtn.addEventListener('click', stopNumberFilter);
    if (uiElements.exportValidBtn) uiElements.exportValidBtn.addEventListener('click', exportValidNumbers);
    
    if (uiElements.btnUploadFilter && uiElements.filterFileInput) {
        uiElements.btnUploadFilter.addEventListener('click', () => {
            uiElements.filterFileInput.click();
        });
        uiElements.filterFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(event) {
                const content = event.target.result;
                const numbers = content.split(/\r?\n/).map(l => l.trim().replace(/[^0-9]/g, '')).filter(n => n.length > 5).join('\n');
                uiElements.filterInput.value = numbers;
                uiElements.filterFileInput.value = '';
                alert(`تم تحميل ${numbers.split('\n').length} رقم للفحص.`);
            };
            reader.readAsText(file);
        });
    }
}

function switchTab(tabName) {
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const selectedNav = document.querySelector(`.nav-item[data-tab="${tabName}"]`);
    if (selectedNav) selectedNav.classList.add('active');

    document.querySelectorAll('.tab-section').forEach(el => el.classList.remove('active-section'));
    const selectedTab = document.getElementById('tab-' + tabName);
    if(selectedTab) selectedTab.classList.add('active-section');
}

// ================================================================= //
// =============== 3. SOCKET.IO (الاتصال) ========================== //
// ================================================================= //
function initializeWhatsAppConnection() {
    socket = io({ auth: { token } });
    
    socket.on('connect', () => { 
        log('🔌 متصل بالسيرفر...', 'blue'); 
        socket.emit('init-whatsapp', token); 
    });

    socket.on('qr', (qr) => {
        isWhatsappReady = false;
        uiElements.statusMessage.textContent = 'امسح الكود (QR):';
        uiElements.statusMessage.style.color = 'orange';
        uiElements.qrcodeCanvas.style.display = 'block';
        if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'none';
        QRCode.toCanvas(uiElements.qrcodeCanvas, qr, { width: 256 }, (err) => {});
    });

    socket.on('status', (status) => {
        uiElements.statusMessage.textContent = status.message;
        
        if (status.ready) {
            isWhatsappReady = true;
            uiElements.statusMessage.style.color = '#00d26a';
            uiElements.qrcodeCanvas.style.display = 'none';
            if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'inline-block';
            
            // إعادة تحميل البيانات عند الاتصال
            loadInitialData();
            log('✅ WhatsApp متصل!', 'green');
        } else {
            isWhatsappReady = false;
            uiElements.statusMessage.style.color = 'orange';
            if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'none';
        }
    });

    socket.on('whatsapp-logged-out', () => {
        log('ℹ️ تم تسجيل الخروج.', 'orange');
        clients = []; 
        importedClients = [];
        // تصفير الواجهة
        if(uiElements.clientsList) uiElements.clientsList.innerHTML = '<p class="empty-list">القائمة فارغة.</p>';
        if(uiElements.importedClientsList) uiElements.importedClientsList.innerHTML = '<p class="empty-list">القائمة فارغة.</p>';
        if(uiElements.statTotal) uiElements.statTotal.innerText = '0';
        
        socket.emit('init-whatsapp', token);
        uiElements.qrcodeCanvas.style.display = 'block';
        if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'none';
    });

    socket.on('send-promo-status', (status) => {
        if (status.success) log(`✅ تم الإرسال: +${status.phone}`, "green");
        else log(`❌ فشل: +${status.phone} (${status.error})`, "red");
    });

    // Filter Events
    socket.on('filter-result', (data) => {
        const div = document.createElement('div');
        div.innerText = data.phone;
        div.style.padding = "2px 5px";
        div.style.borderBottom = "1px solid rgba(255,255,255,0.05)";

        if (data.status === 'valid') {
            div.style.color = "#4ade80";
            uiElements.listValid.appendChild(div);
            validNumbersBuffer.push(data.phone);
            uiElements.countValid.innerText = validNumbersBuffer.length;
            if (uiElements.exportValidBtn.disabled) {
                uiElements.exportValidBtn.disabled = false;
                uiElements.exportValidBtn.classList.remove('btn-secondary');
                uiElements.exportValidBtn.classList.add('btn-success');
            }
        } else {
            div.style.color = "#f87171";
            uiElements.listInvalid.appendChild(div);
            uiElements.countInvalid.innerText = parseInt(uiElements.countInvalid.innerText) + 1;
        }
    });

    socket.on('filter-complete', () => { resetFilterUI(false); uiElements.filterStatus.innerText = `✅ انتهى الفحص.`; });
    socket.on('filter-stopped', () => { resetFilterUI(false); uiElements.filterStatus.innerText = "🛑 تم التوقف."; log('🛑 Filter stopped.', 'orange'); });
    socket.on('filter-error', (msg) => { alert(msg); resetFilterUI(false); uiElements.filterStatus.innerText = "❌ خطأ."; });

    socket.on('sync-complete', () => { 
        log('✅ تمت المزامنة (Contacts Synced).', 'green'); 
        loadClients(); 
    });
    
    socket.on('log', (data) => log(data.message, data.color));
}

// ================================================================= //
// ================= 4. IMPORT & UPLOAD (FIXED) ==================== //
// ================================================================= //

async function importCSV() { 
    const fileInput = document.getElementById('csvFileInput');
    const file = fileInput.files[0]; 
    
    if (!file) return alert('⚠️ المرجو اختيار ملف CSV.'); 
    
    const btn = document.getElementById('importCsvBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    btn.disabled = true;

    const formData = new FormData(); 
    formData.append('csv', file); 
    
    try { 
        const res = await apiFetch('/import-csv', { method: 'POST', body: formData }); 
        
        // التحقق من نجاح العملية
        if (res && res.imported > 0) {
            log(`✅ تم استيراد ${res.imported} رقم بنجاح.`, 'green'); 
            alert(`تم استيراد ${res.imported} رقم.`);
            fileInput.value = ''; 
            loadImportedClients(); // تحديث القائمة
        } else {
            alert("⚠️ الملف فارغ أو لا يحتوي على عمود 'phone'. تأكد من التنسيق.");
        }
    } catch (err) {
        console.error(err);
        alert("❌ فشل الرفع: " + err.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function addNewPromo() {
    const text = uiElements.newPromoText.value.trim();
    const imageFile = uiElements.newPromoImage.files[0];
    if (!text && !imageFile) return alert('أدخل النص أو الصورة.');
    
    const btn = uiElements.addNewPromoBtn;
    btn.disabled = true;
    btn.innerHTML = 'جاري الحفظ...';

    const formData = new FormData(); 
    formData.append('text', text);
    if (imageFile) formData.append('image', imageFile);
    
    try { 
        await apiFetch('/addPromo', { method: 'POST', body: formData }); 
        log("✅ تم حفظ العرض.", 'green'); 
        uiElements.newPromoText.value = ''; 
        uiElements.newPromoImage.value = '';
        loadPromos(); 
    } catch (err) {
        alert("خطأ في الحفظ");
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save"></i> حفظ العرض';
    }
}

// ================================================================= //
// ================= 5. FILTER FUNCTIONS =========================== //
// ================================================================= //

function startNumberFilter() {
    const text = uiElements.filterInput.value.trim();
    if (!text) return alert("أدخل أرقاماً للفحص.");
    
    uiElements.listValid.innerHTML = '';
    uiElements.listInvalid.innerHTML = '';
    uiElements.countValid.innerText = '0';
    uiElements.countInvalid.innerText = '0';
    uiElements.filterStatus.innerText = "جاري الفحص... ⏳";
    
    validNumbersBuffer = [];

    uiElements.startFilterBtn.style.display = 'none';
    if(uiElements.stopFilterBtn) {
        uiElements.stopFilterBtn.style.display = 'inline-block';
        uiElements.stopFilterBtn.disabled = false;
        uiElements.stopFilterBtn.textContent = "توقف";
    }
    uiElements.exportValidBtn.disabled = true;

    socket.emit('check-numbers', { numbers: text });
}

function stopNumberFilter() {
    if(confirm("إيقاف؟")) {
        if(uiElements.stopFilterBtn) {
            uiElements.stopFilterBtn.textContent = "جاري التوقف...";
            uiElements.stopFilterBtn.disabled = true;
        }
        socket.emit('stop-filter');
    }
}

function resetFilterUI(isRunning) {
    uiElements.startFilterBtn.style.display = 'inline-block';
    if(uiElements.stopFilterBtn) uiElements.stopFilterBtn.style.display = 'none';
    if (validNumbersBuffer.length > 0) uiElements.exportValidBtn.disabled = false;
}

function exportValidNumbers() {
    if (validNumbersBuffer.length === 0) return alert("لا توجد أرقام.");
    const csvContent = "Phone\n" + validNumbersBuffer.join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `valid_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    if(confirm("مسح النتائج؟")) {
        uiElements.listValid.innerHTML = '';
        uiElements.listInvalid.innerHTML = '';
        uiElements.countValid.innerText = '0';
        uiElements.countInvalid.innerText = '0';
        uiElements.filterInput.value = '';
        uiElements.exportValidBtn.disabled = true;
        uiElements.exportValidBtn.classList.remove('btn-success');
        uiElements.exportValidBtn.classList.add('btn-secondary');
        uiElements.filterStatus.innerText = "...";
        validNumbersBuffer = [];
    }
}

// ================================================================= //
// ==================== 6. DATA & API ============================== //
// ================================================================= //

async function apiFetch(url, options = {}) {
    const headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
    if (!(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; }
    try {
        const response = await fetch(url, { ...options, headers });
        if (response.status === 401) { handleLogout(true); throw new Error('Session Expired'); }
        if (response.status === 403) { window.location.replace('/activate.html'); throw new Error('Expired'); }
        const text = await response.text();
        return text ? JSON.parse(text) : {};
    } catch (error) { throw error; }
}

function loadInitialData() { 
    loadClients(); 
    loadImportedClients(); 
    loadPromos(); 
    loadChatbotPrompt(); 
    loadChatbotStatus();
}

async function loadClients() { 
    try { 
        clients = await apiFetch("/contacts") || []; 
        displayClients(uiElements.clientsList, clients); 
    } catch (err) {} 
}

async function loadImportedClients() { 
    try { 
        importedClients = await apiFetch("/imported-contacts") || []; 
        displayClients(uiElements.importedClientsList, importedClients); 
    } catch (err) {} 
}

async function loadPromos() { 
    try { 
        promos = await apiFetch("/promos") || []; 
        displayPromos(); 
    } catch (err) {} 
}

function displayClients(container, list) {
    container.innerHTML = "";
    if (!list || !list.length) { container.innerHTML = `<p class="empty-list">القائمة فارغة.</p>`; return; }
    list.forEach(client => {
        const div = document.createElement("div");
        div.className = 'client-item';
        div.innerHTML = `<span>${client.name || 'Unknown'} <strong>+${client.phone}</strong></span>`;
        container.appendChild(div);
    });
    updateTotalStats();
}

function displayPromos() {
    uiElements.promosList.innerHTML = "";
    if (!promos || !promos.length) { uiElements.promosList.innerHTML = `<p class="empty-list">لا توجد عروض.</p>`; return; }
    promos.forEach(promo => {
        const div = document.createElement("div");
        div.className = "promo";
        div.id = `promo-${promo.id}`;
        const imageHtml = promo.image ? `<img src="promos/${promo.image}" alt="Promo">` : '';
        div.innerHTML = `${imageHtml}<p>${promo.text.slice(0, 50)}...</p><div class="promo-buttons"><button class="btn-select">اختيار</button><button class="btn-delete">حذف</button></div>`;
        div.querySelector('.btn-select').addEventListener('click', () => selectPromo(promo.id));
        div.querySelector('.btn-delete').addEventListener('click', () => deletePromo(promo.id));
        uiElements.promosList.appendChild(div);
    });
}

function updateTotalStats() {
    if(uiElements.statTotal) {
        const total = (clients.length || 0) + (importedClients.length || 0);
        uiElements.statTotal.innerText = total;
    }
}

// Helpers
function selectPromo(id) { selectedPromoId = id; log(`🔵 Selected #${id}`, "blue"); document.querySelectorAll('.promo').forEach(p => p.classList.remove('selected')); document.getElementById(`promo-${id}`).classList.add('selected'); }
async function deletePromo(id) { if (!confirm("Delete?")) return; try { await apiFetch(`/deletePromo/${id}`, { method: "DELETE" }); loadPromos(); } catch (err) {} }
async function deleteAllImported() { if (!confirm("Delete All?")) return; try { await apiFetch('/api/delete-all-imported', { method: 'DELETE' }); loadImportedClients(); } catch(err) {} }
function exportClientsToCSV() {
    if (!clients.length) return alert("Empty.");
    const csv = ['phone,name', ...clients.map(c => `${c.phone},${c.name||''}`)].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "contacts.csv"; document.body.appendChild(link); link.click(); document.body.removeChild(link);
}

async function loadChatbotPrompt() { try { const d = await apiFetch('/api/chatbot-prompt'); if(uiElements.chatbotPrompt) uiElements.chatbotPrompt.value = d.prompt || ''; } catch (e) {} }
async function saveChatbotPrompt() { try { await apiFetch('/api/chatbot-prompt', { method: 'POST', body: JSON.stringify({ prompt: uiElements.chatbotPrompt.value }) }); log(`✅ Saved.`, 'green'); } catch (e) {} }
function requestContactSync() { if (!isWhatsappReady) return alert('Offline'); log('🔄 Syncing...', 'blue'); if(uiElements.syncContactsBtn) uiElements.syncContactsBtn.disabled = true; socket.emit('sync-contacts'); }
async function loadChatbotStatus() { try { const d = await apiFetch('/api/chatbot-status'); if(uiElements.chatbotStatusToggle) uiElements.chatbotStatusToggle.checked = d.isActive; } catch (e) {} }
async function toggleChatbotStatus() { try { await apiFetch('/api/chatbot-status', { method: 'POST', body: JSON.stringify({ isActive: uiElements.chatbotStatusToggle.checked }) }); log(`✅ Updated.`, 'green'); } catch (e) {} }
async function generateSpintax() {
    const text = uiElements.newPromoText.value.trim(); if(!text) return alert("Text needed.");
    if(uiElements.generateSpintaxBtn) uiElements.generateSpintaxBtn.disabled = true;
    try { const res = await apiFetch('/api/generate-spintax', { method: 'POST', body: JSON.stringify({ text }) }); if(res.spintax) uiElements.newPromoText.value = res.spintax; } catch(e){} finally { if(uiElements.generateSpintaxBtn) uiElements.generateSpintaxBtn.disabled = false; }
}

function sendPromo(phone, promoId, fromImported) { if (!isWhatsappReady) return; log(`⏳ Sending +${phone}...`, 'blue'); socket.emit('send-promo', { phone, promoId, fromImported }); }
function sendSelectedPromo() { const p = uiElements.phoneInput.value.trim(); if(!p) return alert("Number?"); if(!selectedPromoId) return alert("Promo?"); sendPromo(p, selectedPromoId, false); }
async function sendPromoSequentially(list, fromImported) {
    if(!selectedPromoId) return alert("Promo?"); if(!list.length) return alert("List empty."); if(!isWhatsappReady) return alert("Offline."); if(!confirm(`Start for ${list.length}?`)) return;
    socket.emit('start-campaign-mode', { promoId: selectedPromoId });
    uiElements.sendSequentiallyClientsBtn.disabled = true; uiElements.sendSequentiallyImportedBtn.disabled = true;
    isCampaignRunning = true;
    for (let i = 0; i < list.length; i++) {
        if (!isWhatsappReady) break; sendPromo(list[i].phone, selectedPromoId, fromImported);
        if (i < list.length - 1) await new Promise(r => setTimeout(r, 5000 + Math.random()*5000));
    }
    isCampaignRunning = false;
    uiElements.sendSequentiallyClientsBtn.disabled = false; uiElements.sendSequentiallyImportedBtn.disabled = false;
}

async function handleLogout(f=false) { if(!f && !confirm("Logout?")) return; try{await apiFetch('/api/auth/logout', {method:'POST'});}catch(e){} localStorage.removeItem('authToken'); window.location.replace('index.html'); }
function log(msg, color="black") { const p = document.createElement("p"); p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`; p.style.color = color; uiElements.logsContainer.prepend(p); }
function setupLogsObserver() {
    const logsContainer = uiElements.logsContainer; if(!logsContainer) return;
    const observer = new MutationObserver((mutations) => {
        if (!isCampaignRunning) return;
        mutations.forEach((mutation) => { mutation.addedNodes.forEach((node) => { if (node.nodeType === 1) { const text = node.innerText.toLowerCase(); if (text.includes('success') || text.includes('تم إرسال')) { globalSuccessCount++; uiElements.statSuccess.innerText = globalSuccessCount; } if (text.includes('fail') || text.includes('error')) { globalFailCount++; uiElements.statFailed.innerText = globalFailCount; } } }); });
    });
    observer.observe(logsContainer, { childList: true });
}
