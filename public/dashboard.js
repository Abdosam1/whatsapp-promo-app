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
const adminNumber = "212619145177";

const uiElements = {
    logoutBtn: document.getElementById('logoutBtn'),
    statusCard: document.getElementById('whatsapp-status-card'),
    mainContent: document.getElementById('main-content'),
    statusMessage: document.getElementById('status-message'),
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
    // --- عناصر الشات بوت الجديدة ---
    chatbotPrompt: document.getElementById('chatbotPrompt'),
    savePromptBtn: document.getElementById('savePromptBtn')
};

// ================================================================= //
// ==================== 3. نقطة انطلاق التطبيق ===================== //
// ================================================================= //
document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    initializeWhatsAppConnection();
});

function initializeEventListeners() {
    uiElements.logoutBtn.addEventListener('click', () => handleLogout(false));
    uiElements.addNewPromoBtn.addEventListener('click', addNewPromo);
    uiElements.importCsvBtn.addEventListener('click', importCSV);
    uiElements.sendSequentiallyClientsBtn.addEventListener('click', () => sendPromoSequentially(clients, false));
    uiElements.sendSequentiallyImportedBtn.addEventListener('click', () => sendPromoSequentially(importedClients, true));
    uiElements.sendSelectedPromoBtn.addEventListener('click', sendSelectedPromo);
    if (uiElements.deleteAllImportedBtn) {
        uiElements.deleteAllImportedBtn.addEventListener('click', deleteAllImported);
    }
    if (uiElements.exportClientsBtn) {
        uiElements.exportClientsBtn.addEventListener('click', exportClientsToCSV);
    }
    // --- ربط زر حفظ إعدادات الشات بوت ---
    if (uiElements.savePromptBtn) {
        uiElements.savePromptBtn.addEventListener('click', saveChatbotPrompt);
    }
}

// ================================================================= //
// =============== 4. الاتصال بواتساب عبر Socket.IO ================ //
// ================================================================= //
function initializeWhatsAppConnection() {
    socket = io({ auth: { token } });
    socket.on('connect', () => { log('🔌 متصل بالخادم، جاري تهيئة واتساب...', 'blue'); socket.emit('init-whatsapp', token); });
    socket.on('qr', (qr) => {
        isWhatsappReady = false;
        uiElements.statusMessage.textContent = 'يرجى مسح هذا الـ QR Code للاتصال:';
        uiElements.qrcodeCanvas.style.display = 'block';
        QRCode.toCanvas(uiElements.qrcodeCanvas, qr, { width: 256 }, (err) => { if (err) console.error(err); });
    });
    socket.on('status', (status) => {
        uiElements.statusMessage.textContent = status.message;
        if (status.ready) {
            isWhatsappReady = true;
            uiElements.qrcodeCanvas.style.display = 'none';
            uiElements.statusCard.style.backgroundColor = '#d4edda';
            log('✅ تم الاتصال بواتساب بنجاح! سيتم تحميل بياناتك.', 'green');
            setTimeout(() => {
                uiElements.statusCard.style.display = 'none';
                uiElements.mainContent.style.display = 'block';
                loadInitialData();
            }, 1500);
        } else {
            isWhatsappReady = false;
            if (status.error) uiElements.statusCard.style.backgroundColor = '#f8d7da';
        }
    });
    socket.on('send-promo-status', (status) => {
        if (status.success) log(`✅ تم إرسال العرض بنجاح إلى +${status.phone}`, "green");
        else log(`❌ فشل الإرسال إلى +${status.phone}: ${status.error}`, "red");
    });
    socket.on('disconnect', () => { isWhatsappReady = false; log('🔌 تم قطع الاتصال بالخادم، حاول تحديث الصفحة.', 'orange'); });
    // استقبال رسائل السجل من السيرفر
    socket.on('log', (data) => log(data.message, data.color));
}

// ================================================================= //
// ============= 5. دالة مركزية للتواصل مع الـ API ================= //
// ================================================================= //
async function apiFetch(url, options = {}) {
    const headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
    if (!(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; }
    try {
        const response = await fetch(url, { ...options, headers });
        if (response.status === 401) { handleLogout(true); throw new Error('فشل التحقق من الهوية، انتهت الجلسة.'); }
        if (response.status === 403) {
            const errorData = await response.json().catch(() => ({}));
            if (errorData.subscriptionExpired) {
                alert('انتهت صلاحية اشتراكك أو الفترة التجريبية. سيتم توجيهك لصفحة التفعيل.');
                window.location.replace('/activate.html');
                throw new Error('Subscription expired');
            }
        }
        if (!response.ok) {
            const errJson = await response.json().catch(() => null);
            throw new Error(errJson ? errJson.message : `خطأ من الخادم: ${response.statusText}`);
        }
        const text = await response.text();
        return text ? JSON.parse(text) : {};
    } catch (error) {
        if (error.message !== 'Subscription expired') { log(`❌ حدث خطأ في الشبكة أو الخادم: ${error.message}`, 'red'); }
        throw error;
    }
}

// ================================================================= //
// =================== 6. تحميل وعرض البيانات ====================== //
// ================================================================= //
function loadInitialData() { 
    log('🔄 جاري تحميل البيانات الأولية...', 'blue'); 
    loadClients(); 
    loadImportedClients(); 
    loadPromos();
    loadChatbotPrompt(); // تحميل إعدادات الشات بوت
}
async function loadClients() { try { clients = await apiFetch("/contacts") || []; displayClients(uiElements.clientsList, clients, 'contacts'); } catch (err) {} }
async function loadImportedClients() { try { importedClients = await apiFetch("/imported-contacts") || []; displayClients(uiElements.importedClientsList, importedClients, 'imported'); } catch (err) {} }
async function loadPromos() { try { promos = await apiFetch("/promos") || []; displayPromos(); } catch (err) {} }

function displayClients(container, list, type) { /* ... يبقى كما هو ... */ }
function displayPromos() { /* ... يبقى كما هو ... */ }

// ================================================================= //
// =================== 7. وظائف التفاعل مع المستخدم ================= //
// ================================================================= //
async function addNewPromo() { /* ... يبقى كما هو ... */ }
async function importCSV() { /* ... يبقى كما هو ... */ }
function selectPromo(id) { /* ... يبقى كما هو ... */ }
async function deletePromo(id) { /* ... يبقى كما هو ... */ }
async function deleteAllImported() { /* ... يبقى كما هو ... */ }
function exportClientsToCSV() { /* ... يبقى كما هو ... */ }

// --- وظائف جديدة خاصة بالشات بوت ---
async function loadChatbotPrompt() {
    try {
        const data = await apiFetch('/api/chatbot-prompt');
        if (uiElements.chatbotPrompt && data.prompt) {
            uiElements.chatbotPrompt.value = data.prompt;
        }
    } catch (error) {
        console.error("Failed to load chatbot prompt:", error);
    }
}

async function saveChatbotPrompt() {
    const prompt = uiElements.chatbotPrompt.value;
    try {
        const result = await apiFetch('/api/chatbot-prompt', {
            method: 'POST',
            body: JSON.stringify({ prompt })
        });
        log(`✅ ${result.message}`, 'green');
    } catch (error) {
        console.error("Failed to save chatbot prompt:", error);
    }
}

// ================================================================= //
// ========================= 8. وظائف الإرسال ======================= //
// ================================================================= //
function sendPromo(phone, promoId, fromImported) { if (!isWhatsappReady || !socket) { alert('❌ واتساب غير متصل. يرجى الانتظار.'); return; } log(`⏳ جاري إرسال العرض إلى +${phone}...`, 'blue'); socket.emit('send-promo', { phone, promoId, fromImported }); }
function sendSelectedPromo() { const phone = uiElements.phoneInput.value.trim(); if (!phone) return alert("الرجاء إدخال رقم هاتف."); if (!selectedPromoId) return alert("الرجاء اختيار عرض أولاً."); sendPromo(phone, selectedPromoId, false); }

// --- تعديل دالة الإرسال المتسلسل ---
async function sendPromoSequentially(list, fromImported) {
    if (!selectedPromoId) return alert("الرجاء اختيار عرض أولاً.");
    if (!list || list.length === 0) return alert("القائمة فارغة.");
    if (!isWhatsappReady) return alert("يرجى انتظار اتصال واتساب أولاً.");
    if (!confirm(`هل أنت متأكد من إرسال العرض لـ ${list.length} رقم؟ سيتم تفعيل المساعد الذكي لهذه الحملة.`)) return;

    // تفعيل وضع الحملة في السيرفر
    log('🤖 جاري تفعيل وضع الحملة والمساعد الذكي...', 'blue');
    socket.emit('start-campaign-mode', { promoId: selectedPromoId });

    uiElements.sendSequentiallyClientsBtn.disabled = true;
    uiElements.sendSequentiallyImportedBtn.disabled = true;

    log(`🚀 بدأت حملة الإرسال لـ ${list.length} رقم.`, 'purple');
    for (let i = 0; i < list.length; i++) {
        const client = list[i];
        if (!isWhatsappReady) { log('🛑 توقفت الحملة، انقطع اتصال واتساب.', 'red'); break; }
        sendPromo(client.phone, selectedPromoId, fromImported);
        if (i < list.length - 1) {
            const delay = 30000 + Math.random() * 30000;
            log(`⏳ انتظار ${Math.round(delay/1000)} ثانية قبل الإرسال التالي...`, "orange");
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    log('🎉 انتهت حملة الإرسال. المساعد الذكي سيبقى نشطاً للرد على الأجوبة.', 'green');
    
    uiElements.sendSequentiallyClientsBtn.disabled = false;
    uiElements.sendSequentiallyImportedBtn.disabled = false;
}

// ================================================================= //
// ====================== 9. وظائف مساعدة أخرى ====================== //
// ================================================================= //
async function handleLogout(isForced = false) {
    if (!isForced && !confirm("هل أنت متأكد من رغبتك في تسجيل الخروج؟")) return;
    if (isForced) {
        alert("انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً.");
    } else {
        log('🔒 جاري تسجيل الخروج وتدمير جلسة واتساب...', 'orange');
        try {
            await apiFetch('/api/auth/logout', { method: 'POST' });
            log('✅ تم تدمير جلسة واتساب بنجاح.', 'green');
        } catch (error) {
            console.error('Logout request to server failed, but logging out locally.', error);
        }
    }
    localStorage.removeItem('authToken');
    window.location.replace('index.html');
}

function log(message, color = "black") {
    const p = document.createElement("p");
    p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    p.style.color = color;
    uiElements.logsContainer.prepend(p);
}
