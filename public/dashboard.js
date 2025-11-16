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
    testMessageBtn: document.getElementById('testMessageBtn'),
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
    uiElements.testMessageBtn.addEventListener('click', testMessage);
    if (uiElements.deleteAllImportedBtn) {
        uiElements.deleteAllImportedBtn.addEventListener('click', deleteAllImported);
    }
}

// ================================================================= //
// =============== 4. الاتصال بواتساب عبر Socket.IO ================ //
// ================================================================= //
function initializeWhatsAppConnection() {
    socket = io({ auth: { token: token } });
    
    socket.on('connect', () => {
        log('🔌 متصل بالخادم، جاري تهيئة واتساب...', 'blue');
        socket.emit('init-whatsapp', token);
    });
    
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

    socket.on('disconnect', () => {
        isWhatsappReady = false;
        log('🔌 تم قطع الاتصال بالخادم، حاول تحديث الصفحة.', 'orange');
    });
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
}

async function loadClients() { try { clients = await apiFetch("/contacts") || []; displayClients(uiElements.clientsList, clients, 'contacts'); } catch (err) {} }
async function loadImportedClients() { try { importedClients = await apiFetch("/imported-contacts") || []; displayClients(uiElements.importedClientsList, importedClients, 'imported'); } catch (err) {} }
async function loadPromos() { try { promos = await apiFetch("/promos") || []; displayPromos(); } catch (err) {} }

function displayClients(container, list, type) {
    container.innerHTML = "";
    const title = type === 'contacts' ? 'جهات الاتصال' : 'الأرقام المستوردة';
    if (!list || !list.length) { container.innerHTML = `<p class="empty-list">قائمة ${title} فارغة.</p>`; return; }
    list.forEach(client => {
        const div = document.createElement("div");
        div.className = 'client-item';
        div.innerHTML = `<span>${client.name || ''} <strong>+${client.phone}</strong></span>`;
        container.appendChild(div);
    });
}

function displayPromos() {
    uiElements.promosList.innerHTML = "";
    if (!promos || !promos.length) { uiElements.promosList.innerHTML = `<p class="empty-list">لم تقم بإضافة أي عروض بعد.</p>`; return; }
    promos.forEach(promo => {
        const div = document.createElement("div");
        div.className = "promo";
        div.id = `promo-${promo.id}`;
        div.innerHTML = `
            <img src="promos/${promo.image}" alt="صورة العرض">
            <p title="${promo.text}">${promo.text.slice(0, 50)}...</p>
            <div class="promo-buttons">
                <button type="button" class="btn-select"><i class="fas fa-check"></i> اختيار</button>
                <button type="button" class="btn-delete"><i class="fas fa-trash"></i> حذف</button>
            </div>`;
        div.querySelector('.btn-select').addEventListener('click', () => selectPromo(promo.id));
        div.querySelector('.btn-delete').addEventListener('click', () => deletePromo(promo.id));
        uiElements.promosList.appendChild(div);
    });
}

// ================================================================= //
// =================== 7. وظائف التفاعل مع المستخدم ================= //
// ================================================================= //
async function addNewPromo() { /* ... الكود يبقى كما هو ... */ }
async function importCSV() { /* ... الكود يبقى كما هو ... */ }
function selectPromo(id) { /* ... الكود يبقى كما هو ... */ }
async function deletePromo(id) { /* ... الكود يبقى كما هو ... */ }

// --- هذه هي الدالة الجديدة المطلوبة ---
async function deleteAllImported() {
    if (!confirm("هل أنت متأكد من حذف جميع الأرقام المستوردة؟ لا يمكن التراجع عن هذا الإجراء.")) {
        return;
    }
    try {
        const result = await apiFetch('/api/delete-all-imported', { method: 'DELETE' });
        log(`✅ ${result.message}`, 'green');
        loadImportedClients(); // إعادة تحميل القائمة لتظهر فارغة
    } catch(err) {
        console.error("Failed to delete all imported clients:", err);
    }
}

// ================================================================= //
// ========================= 8. وظائف الإرسال ======================= //
// ================================================================= //
function sendPromo(phone, promoId, fromImported) { /* ... الكود يبقى كما هو ... */ }
function sendSelectedPromo() { /* ... الكود يبقى كما هو ... */ }
function testMessage() { /* ... الكود يبقى كما هو ... */ }
async function sendPromoSequentially(list, fromImported) { /* ... الكود يبقى كما هو ... */ }

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
