// ================================================================= //
// ============ 0. معالجة التوكن عند الدخول عبر جوجل ============ //
// ================================================================= //
const urlParams = new URLSearchParams(window.location.search);
const tokenFromUrl = urlParams.get('token');
if (tokenFromUrl) {
    localStorage.setItem('authToken', tokenFromUrl);
    window.history.replaceState({}, document.title, "/dashboard.html");
}

// ================================================================= //
// ==================== 1. التحقق من الأمان أولاً =================== //
// ================================================================= //
const token = localStorage.getItem('authToken');
if (!token) {
    window.location.replace('index.html');
}

// ================================================================= //
// ======================== 2. إعدادات عامة ======================== //
// ================================================================= //
let clients = [];
let importedClients = [];
let promos = [];
let selectedPromoId = null;
let socket = null;
let isWhatsappReady = false;

// متغيرات العداد (Stats)
let isCampaignRunning = false;
let globalSuccessCount = 0;
let globalFailCount = 0;

// متغيرات فلتر الأرقام (Filter)
let validNumbersBuffer = [];

const uiElements = {
    logoutBtn: document.getElementById('logoutBtn'),
    statusCard: document.getElementById('whatsapp-status-card'),
    mainContent: document.getElementById('main-content'),
    statusMessage: document.getElementById('status-message-display') || document.getElementById('status-message'),
    qrcodeCanvas: document.getElementById('qrcode-canvas'),
    clientsList: document.getElementById('clientsList'),
    importedClientsList: document.getElementById('importedClientsList'),
    promosList: document.getElementById('promosList'),
    logsContainer: document.getElementById('logs'),
    sendSequentiallyClientsBtn: document.getElementById('sendSequentiallyClientsBtn'),
    csvFileInput: document.getElementById('csvFileInput'),
    importCsvBtn: document.getElementById('importCsvBtn'),
    sendSequentiallyImportedBtn: document.getElementById('sendSequentiallyImportedBtn'),
    deleteAllImportedBtn: document.getElementById('deleteAllImportedBtn'),
    newPromoText: document.getElementById('newPromoText'),
    newPromoImage: document.getElementById('newPromoImage'),
    addNewPromoBtn: document.getElementById('addNewPromoBtn'),
    phoneInput: document.getElementById('phoneInput'),
    sendSelectedPromoBtn: document.getElementById('sendSelectedPromoBtn'),
    exportClientsBtn: document.getElementById('exportClientsBtn'),
    chatbotPrompt: document.getElementById('chatbotPrompt'),
    savePromptBtn: document.getElementById('savePromptBtn'),
    syncContactsBtn: document.getElementById('syncContactsBtn'),
    chatbotStatusToggle: document.getElementById('chatbotStatusToggle'),
    generateSpintaxBtn: document.getElementById('generateSpintaxBtn'),
    disconnectWhatsappBtn: document.getElementById('disconnectWhatsappBtn'),
    statSuccess: document.getElementById('stat-sent-success'),
    statFailed: document.getElementById('stat-sent-failed'),
    statTotal: document.getElementById('stat-total-contacts'),
    
    // === عناصر الفلتر الجديدة (تمت إضافتها) ===
    filterInput: document.getElementById('filterInput'),
    startFilterBtn: document.getElementById('startFilterBtn'),
    stopFilterBtn: document.getElementById('stopFilterBtn'), // زر التوقف
    exportValidBtn: document.getElementById('exportValidBtn'),
    listValid: document.getElementById('listValid'),
    listInvalid: document.getElementById('listInvalid'),
    countValid: document.getElementById('countValid'),
    countInvalid: document.getElementById('countInvalid'),
    filterStatus: document.getElementById('filterStatus'),
    // عناصر رفع ملف الفلتر
    filterFileInput: document.getElementById('filterFileInput'),
    btnUploadFilter: document.getElementById('btnUploadFilter')
};

// ================================================================= //
// ==================== 3. نقطة انطلاق التطبيق ===================== //
// ================================================================= //
document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    initializeWhatsAppConnection();
    setupLogsObserver();
});

function initializeEventListeners() {
    // 1. تفعيل القائمة الجانبية (Sidebar)
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tabName = item.getAttribute('data-tab');
            if (tabName) {
                switchTab(tabName);
            }
        });
    });

    // 2. الأزرار الرئيسية
    uiElements.logoutBtn.addEventListener('click', () => handleLogout(false));
    uiElements.addNewPromoBtn.addEventListener('click', addNewPromo);
    uiElements.importCsvBtn.addEventListener('click', importCSV);
    
    uiElements.sendSequentiallyClientsBtn.addEventListener('click', () => {
        startNewCampaign();
        sendPromoSequentially(clients, false);
    });
    uiElements.sendSequentiallyImportedBtn.addEventListener('click', () => {
        startNewCampaign();
        sendPromoSequentially(importedClients, true);
    });
    uiElements.sendSelectedPromoBtn.addEventListener('click', () => {
        startNewCampaign();
        sendSelectedPromo();
    });

    if (uiElements.deleteAllImportedBtn) uiElements.deleteAllImportedBtn.addEventListener('click', deleteAllImported);
    if (uiElements.exportClientsBtn) uiElements.exportClientsBtn.addEventListener('click', exportClientsToCSV);
    if (uiElements.savePromptBtn) uiElements.savePromptBtn.addEventListener('click', saveChatbotPrompt);
    if (uiElements.syncContactsBtn) uiElements.syncContactsBtn.addEventListener('click', requestContactSync);
    if (uiElements.chatbotStatusToggle) uiElements.chatbotStatusToggle.addEventListener('change', toggleChatbotStatus);
    if (uiElements.generateSpintaxBtn) uiElements.generateSpintaxBtn.addEventListener('click', generateSpintax);

    // 3. زر فصل الواتساب
    if (uiElements.disconnectWhatsappBtn) {
        uiElements.disconnectWhatsappBtn.addEventListener('click', () => {
            if(confirm("هل أنت متأكد أنك تريد فصل الرقم وحذف جميع جهات الاتصال الحالية؟")) {
                if(socket) {
                    socket.emit('logout-whatsapp'); 
                    uiElements.statusMessage.innerText = "جاري الفصل وحذف البيانات...";
                    uiElements.disconnectWhatsappBtn.style.display = 'none';
                }
            }
        });
    }

    // === 4. أزرار الفلتر (NEW LOGIC) ===
    if (uiElements.startFilterBtn) uiElements.startFilterBtn.addEventListener('click', startNumberFilter);
    
    // زر التوقف
    if (uiElements.stopFilterBtn) uiElements.stopFilterBtn.addEventListener('click', stopNumberFilter);
    
    if (uiElements.exportValidBtn) uiElements.exportValidBtn.addEventListener('click', exportValidNumbers);
    
    // زر رفع الملف للفلتر
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
                // استخراج الأرقام فقط
                const numbers = content.split(/\r?\n/)
                                    .map(line => line.trim().replace(/[^0-9]/g, ''))
                                    .filter(n => n.length > 5)
                                    .join('\n');
                
                uiElements.filterInput.value = numbers;
                uiElements.filterFileInput.value = ''; // Reset input
            };
            reader.readAsText(file);
        });
    }
}

// ================================================================= //
// ==================== 4. وظيفة التبديل (Switch Tab) ============== //
// ================================================================= //
function switchTab(tabName) {
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const selectedNav = document.querySelector(`.nav-item[data-tab="${tabName}"]`);
    if (selectedNav) selectedNav.classList.add('active');

    document.querySelectorAll('.tab-section').forEach(el => el.classList.remove('active-section'));
    const selectedTab = document.getElementById('tab-' + tabName);
    if(selectedTab) selectedTab.classList.add('active-section');

    // Admin Check injection removed as requested (No blog in dashboard)
}

// ================================================================= //
// =============== 5. الاتصال بواتساب عبر Socket.IO ================ //
// ================================================================= //
function initializeWhatsAppConnection() {
    socket = io({ auth: { token } });
    
    socket.on('connect', () => { 
        log('🔌 متصل بالخادم، جاري تهيئة واتساب...', 'blue'); 
        socket.emit('init-whatsapp', token); 
    });

    socket.on('qr', (qr) => {
        isWhatsappReady = false;
        uiElements.statusMessage.textContent = 'يرجى مسح هذا الـ QR Code للاتصال:';
        uiElements.qrcodeCanvas.style.display = 'block';
        if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'none';
        QRCode.toCanvas(uiElements.qrcodeCanvas, qr, { width: 256 }, (err) => { if (err) console.error(err); });
    });

    socket.on('status', (status) => {
        uiElements.statusMessage.textContent = status.message;
        if (status.ready) {
            isWhatsappReady = true;
            uiElements.qrcodeCanvas.style.display = 'none';
            if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'inline-block';
            loadInitialData();
            log('✅ تم الاتصال بواتساب بنجاح!', 'green');
        } else {
            isWhatsappReady = false;
            if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'none';
        }
    });

    socket.on('whatsapp-logged-out', () => {
        log('ℹ️ تم فصل الواتساب ومسح البيانات. جاري طلب QR جديد...', 'orange');
        clients = [];
        importedClients = [];
        if(uiElements.clientsList) uiElements.clientsList.innerHTML = '<p class="empty-list">القائمة فارغة.</p>';
        if(uiElements.importedClientsList) uiElements.importedClientsList.innerHTML = '<p class="empty-list">القائمة فارغة.</p>';
        if(uiElements.statTotal) uiElements.statTotal.innerText = '0';
        socket.emit('init-whatsapp', token);
        uiElements.qrcodeCanvas.style.display = 'block';
        if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'none';
    });

    socket.on('send-promo-status', (status) => {
        if (status.success) log(`✅ تم إرسال العرض بنجاح إلى +${status.phone}`, "green");
        else log(`❌ فشل الإرسال إلى +${status.phone}: ${status.error}`, "red");
    });

    // --- أحداث الفلتر (Updated Events) ---
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
            
            // === تفعيل زر التحميل فوراً (Instant Enable) ===
            if (uiElements.exportValidBtn.disabled) {
                uiElements.exportValidBtn.disabled = false;
                uiElements.exportValidBtn.classList.remove('btn-secondary');
                uiElements.exportValidBtn.classList.add('btn-success');
            }
        } else {
            div.style.color = "#f87171";
            uiElements.listInvalid.appendChild(div);
            const currentInvalid = parseInt(uiElements.countInvalid.innerText) || 0;
            uiElements.countInvalid.innerText = currentInvalid + 1;
        }
    });

    socket.on('filter-complete', (counts) => {
        resetFilterUI(false);
        uiElements.filterStatus.innerText = `✅ انتهى الفحص. (صالح: ${counts.valid}, غير صالح: ${counts.invalid})`;
    });

    // === حدث التوقف (Stop) ===
    socket.on('filter-stopped', () => {
        resetFilterUI(false);
        uiElements.filterStatus.innerText = "🛑 تم إيقاف الفحص يدوياً.";
        log('🛑 قام المستخدم بإيقاف الفحص.', 'orange');
    });

    socket.on('filter-error', (msg) => {
        alert(msg);
        resetFilterUI(false);
        uiElements.filterStatus.innerText = "❌ حدث خطأ.";
    });

    socket.on('disconnect', () => { isWhatsappReady = false; log('🔌 انقطع الاتصال بالخادم.', 'orange'); });
    socket.on('log', (data) => log(data.message, data.color));
    socket.on('sync-complete', () => { log('✅ اكتمل التحديث.', 'green'); loadClients(); if(uiElements.syncContactsBtn) uiElements.syncContactsBtn.disabled = false; });
}

// ================================================================= //
// ================= 6. دوال الفلتر (FILTER FUNCTIONS) ============= //
// ================================================================= //

function startNumberFilter() {
    const text = uiElements.filterInput.value.trim();
    if (!text) return alert("أدخل أرقاماً للفحص.");
    
    // تهيئة الواجهة
    uiElements.listValid.innerHTML = '';
    uiElements.listInvalid.innerHTML = '';
    uiElements.countValid.innerText = '0';
    uiElements.countInvalid.innerText = '0';
    uiElements.filterStatus.innerText = "جاري الفحص... ⏳";
    
    validNumbersBuffer = [];

    // تبديل الأزرار: إخفاء Start وإظهار Stop
    uiElements.startFilterBtn.style.display = 'none';
    if(uiElements.stopFilterBtn) {
        uiElements.stopFilterBtn.style.display = 'inline-block';
        uiElements.stopFilterBtn.disabled = false;
        uiElements.stopFilterBtn.textContent = "توقف";
    }
    
    uiElements.exportValidBtn.disabled = true;

    // إرسال الطلب للسيرفر
    socket.emit('check-numbers', { numbers: text });
}

// === دالة إيقاف الفلتر ===
function stopNumberFilter() {
    if(confirm("هل تريد حقاً إيقاف عملية الفحص؟")) {
        if(uiElements.stopFilterBtn) {
            uiElements.stopFilterBtn.textContent = "جاري التوقف...";
            uiElements.stopFilterBtn.disabled = true;
        }
        socket.emit('stop-filter');
    }
}

// === إعادة تعيين واجهة الفلتر ===
function resetFilterUI(isRunning) {
    if (!isRunning) {
        uiElements.startFilterBtn.style.display = 'inline-block';
        if(uiElements.stopFilterBtn) uiElements.stopFilterBtn.style.display = 'none';
        
        // إبقاء زر التحميل مفعلاً إذا وجدت نتائج
        if (validNumbersBuffer.length > 0) {
            uiElements.exportValidBtn.disabled = false;
        }
    }
}

function exportValidNumbers() {
    if (validNumbersBuffer.length === 0) return alert("لا توجد أرقام صالحة للتحميل.");

    const csvContent = "Phone\n" + validNumbersBuffer.join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `valid_numbers_${Date.now()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // سؤال مسح النتائج
    if(confirm("تم التحميل! هل تريد مسح النتائج لبدء فحص جديد؟")) {
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
// ==================== 7. Helper Functions ======================== //
// ================================================================= //

function startNewCampaign() {
    isCampaignRunning = true; globalSuccessCount = 0; globalFailCount = 0;
    if(uiElements.statSuccess) uiElements.statSuccess.innerText = "0";
    if(uiElements.statFailed) uiElements.statFailed.innerText = "0";
}

function setupLogsObserver() {
    const logsContainer = uiElements.logsContainer;
    if(!logsContainer) return;

    const observer = new MutationObserver((mutations) => {
        if (!isCampaignRunning) return;

        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1) { 
                     const text = node.innerText.toLowerCase();
                     if (text.includes('success') || text.includes('تم إرسال') || text.includes('sent')) {
                         globalSuccessCount++;
                         if(uiElements.statSuccess) uiElements.statSuccess.innerText = globalSuccessCount;
                     }
                     if (text.includes('fail') || text.includes('error') || text.includes('فشل')) {
                         globalFailCount++;
                         if(uiElements.statFailed) uiElements.statFailed.innerText = globalFailCount;
                     }
                }
            });
        });
    });
    observer.observe(logsContainer, { childList: true });
    setInterval(() => {
        const saved = document.getElementById('clientsList') ? document.getElementById('clientsList').childElementCount : 0;
        const imported = document.getElementById('importedClientsList') ? document.getElementById('importedClientsList').childElementCount : 0;
        if(uiElements.statTotal) uiElements.statTotal.innerText = saved + imported;
    }, 2000);
}

async function apiFetch(url, options = {}) {
    const headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
    if (!(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; }
    try {
        const response = await fetch(url, { ...options, headers });
        if (response.status === 401) { handleLogout(true); throw new Error('Session Expired'); }
        if (response.status === 403) {
            const errorData = await response.json().catch(() => ({}));
            if (errorData.subscriptionExpired) {
                window.location.replace('/activate.html');
                throw new Error('Subscription expired');
            }
        }
        if (!response.ok) throw new Error(`Server Error: ${response.statusText}`);
        const text = await response.text();
        return text ? JSON.parse(text) : {};
    } catch (error) {
        if (error.message !== 'Subscription expired') log(`❌ Error: ${error.message}`, 'red');
        throw error;
    }
}

function loadInitialData() { 
    loadClients(); loadImportedClients(); loadPromos(); loadChatbotPrompt(); loadChatbotStatus();
}

async function loadClients() { try { clients = await apiFetch("/contacts") || []; displayClients(uiElements.clientsList, clients); } catch (err) {} }
async function loadImportedClients() { try { importedClients = await apiFetch("/imported-contacts") || []; displayClients(uiElements.importedClientsList, importedClients); } catch (err) {} }
async function loadPromos() { try { promos = await apiFetch("/promos") || []; displayPromos(); } catch (err) {} }

function displayClients(container, list) {
    container.innerHTML = "";
    if (!list || !list.length) { container.innerHTML = `<p class="empty-list">القائمة فارغة.</p>`; return; }
    list.forEach(client => {
        const div = document.createElement("div");
        div.className = 'client-item';
        div.innerHTML = `<span>${client.name || ''} <strong>+${client.phone}</strong></span>`;
        container.appendChild(div);
    });
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

async function addNewPromo() {
    const text = uiElements.newPromoText.value.trim();
    const imageFile = uiElements.newPromoImage.files[0];
    if (!text && !imageFile) return alert('أدخل بيانات.');
    const formData = new FormData(); formData.append('text', text);
    if (imageFile) formData.append('image', imageFile);
    try { await apiFetch('/addPromo', { method: 'POST', body: formData }); log("✅ Added.", 'green'); uiElements.newPromoText.value = ''; loadPromos(); } catch (err) {}
}

async function importCSV() { 
    const file = uiElements.csvFileInput.files[0]; 
    if (!file) return alert('File required.'); 
    const formData = new FormData(); formData.append('csv', file); 
    try { const res = await apiFetch('/import-csv', { method: 'POST', body: formData }); log(`✅ Imported ${res.imported}.`, 'green'); uiElements.csvFileInput.value = ''; loadImportedClients(); } catch (err) {} 
}

function selectPromo(id) { selectedPromoId = id; log(`🔵 Selected #${id}`, "blue"); document.querySelectorAll('.promo').forEach(p => p.classList.remove('selected')); document.getElementById(`promo-${id}`).classList.add('selected'); }
async function deletePromo(id) { if (!confirm("Delete?")) return; try { await apiFetch(`/deletePromo/${id}`, { method: "DELETE" }); loadPromos(); } catch (err) {} }
async function deleteAllImported() { if (!confirm("Delete All Imported?")) return; try { await apiFetch('/api/delete-all-imported', { method: 'DELETE' }); loadImportedClients(); } catch(err) {} }
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
    for (let i = 0; i < list.length; i++) {
        if (!isWhatsappReady) break; sendPromo(list[i].phone, selectedPromoId, fromImported);
        if (i < list.length - 1) await new Promise(r => setTimeout(r, 10000 + Math.random()*10000));
    }
    uiElements.sendSequentiallyClientsBtn.disabled = false; uiElements.sendSequentiallyImportedBtn.disabled = false;
}

async function handleLogout(f=false) { if(!f && !confirm("Logout?")) return; try{await apiFetch('/api/auth/logout', {method:'POST'});}catch(e){} localStorage.removeItem('authToken'); window.location.replace('index.html'); }
function log(msg, color="black") { const p = document.createElement("p"); p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`; p.style.color = color; uiElements.logsContainer.prepend(p); }
