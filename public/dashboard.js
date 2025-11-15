// ================================================================= //
// ============ 0. معالجة التوكن عند الدخول عبر جوجل (تعديل مهم) ============ //
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

const uiElements = {
    logoutBtn: document.getElementById('logoutBtn'),
    mainContainer: document.querySelector('.container'),
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
    uiElements.logoutBtn.addEventListener('click', handleLogout);
    uiElements.addNewPromoBtn.addEventListener('click', addNewPromo);
    uiElements.importCsvBtn.addEventListener('click', importCSV);
    uiElements.sendSequentiallyClientsBtn.addEventListener('click', () => sendPromoSequentially(clients, false));
    uiElements.sendSequentiallyImportedBtn.addEventListener('click', () => sendPromoSequentially(importedClients, true));
    uiElements.deleteAllImportedBtn.addEventListener('click', deleteAllImportedClients);
    uiElements.sendSelectedPromoBtn.addEventListener('click', sendSelectedPromo);
    uiElements.testMessageBtn.addEventListener('click', testMessage);
}

// ================================================================= //
// =============== 4. الاتصال بواتساب عبر Socket.IO ================ //
// ================================================================= //
function initializeWhatsAppConnection() {
    socket = io({ reconnection: true, reconnectionAttempts: 5 });
    
    socket.on('connect', () => {
        uiElements.statusMessage.textContent = 'جاري طلب الاتصال بواتساب...';
        if (token) socket.emit('init-whatsapp', token);
    });
    
    socket.on('qr', (qr) => {
        uiElements.statusMessage.textContent = 'يرجى مسح هذا الـ QR Code للاتصال:';
        uiElements.qrcodeCanvas.style.display = 'block';
        QRCode.toCanvas(uiElements.qrcodeCanvas, qr, { width: 256 }, (err) => {
            if (err) console.error(err);
        });
    });

    socket.on('status', (status) => {
        uiElements.statusMessage.textContent = status.message;
        if (status.ready) {
            uiElements.qrcodeCanvas.style.display = 'none';
            uiElements.statusCard.style.backgroundColor = '#d4edda';
            log('✅ تم الاتصال بواتساب بنجاح! سيتم تحميل بياناتك.', 'green');
            setTimeout(() => {
                uiElements.statusCard.style.display = 'none';
                uiElements.mainContent.style.display = 'block';
                loadInitialData();
            }, 2000);
        } else if (status.error) {
            uiElements.statusCard.style.backgroundColor = '#f8d7da';
        }
    });

    socket.on('send-promo-status', (status) => {
        if (status.success) {
            log(`✅ تم إرسال العرض بنجاح إلى +${status.phone}`, "green");
        } else {
            log(`❌ فشل الإرسال إلى +${status.phone}: ${status.error}`, "red");
        }
    });

    socket.on('disconnect', () => log('🔌 تم قطع الاتصال، حاول تحديث الصفحة.', 'orange'));
}

// ================================================================= //
// ============= 5. دالة مركزية للتواصل مع الـ API ================= //
// ================================================================= //
async function apiFetch(url, options = {}) {
    const headers = { ...options.headers };
    headers['Authorization'] = `Bearer ${token}`;
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: `Server error: ${response.statusText}` }));
        throw new Error(errorData.message || 'Unknown error');
    }
    const contentType = response.headers.get("content-type");
    return contentType?.includes("application/json") ? response.json() : response.text();
}

// ================================================================= //
// =================== 6. تحميل وعرض البيانات ====================== //
// ================================================================= //
function loadInitialData() {
    loadClients();
    loadImportedClients();
    loadPromos();
}
async function loadClients() { /* ... الكود ديالك كيبقى هنا ... */ }
async function loadImportedClients() { /* ... الكود ديالك كيبقى هنا ... */ }
async function loadPromos() { /* ... الكود ديالك كيبقى هنا ... */ }
// ... باقي دوال العرض displayClients, createPromoCard ...

// ================================================================= //
// =================== 7. وظائف التفاعل الجديدة ===================== //
// ================================================================= //
async function addNewPromo() {
    const text = uiElements.newPromoText.value.trim();
    const image = uiElements.newPromoImage.files[0];
    if (!text || !image) return alert('يرجى إدخال نص العرض واختيار صورة.');

    const formData = new FormData();
    formData.append('text', text);
    formData.append('image', image);
    uiElements.addNewPromoBtn.disabled = true;

    try {
        log('⏳ جاري إضافة العرض الجديد...', 'orange');
        await apiFetch('/promos', { method: 'POST', body: formData });
        log('✅ تم إضافة العرض بنجاح!', 'green');
        uiElements.newPromoText.value = '';
        uiElements.newPromoImage.value = '';
        loadPromos();
    } catch (err) {
        log(`❌ فشل في إضافة العرض: ${err.message}`, 'red');
    } finally {
        uiElements.addNewPromoBtn.disabled = false;
    }
}

async function importCSV() {
    const file = uiElements.csvFileInput.files[0];
    if (!file) return alert('يرجى اختيار ملف CSV أولاً.');

    const formData = new FormData();
    formData.append('csvFile', file);
    uiElements.importCsvBtn.disabled = true;

    try {
        log('⏳ جاري استيراد الأرقام...', 'orange');
        await apiFetch('/imported-contacts/import', { method: 'POST', body: formData });
        log('✅ تم استيراد الأرقام بنجاح.', 'green');
        uiElements.csvFileInput.value = '';
        loadImportedClients();
    } catch (err) {
        log(`❌ فشل استيراد الملف: ${err.message}`, 'red');
    } finally {
        uiElements.importCsvBtn.disabled = false;
    }
}

async function deleteAllImportedClients() {
    if (!confirm("هل أنت متأكد من حذف جميع العملاء المستوردين؟ هذه العملية لا يمكن التراجع عنها.")) return;
    try {
        log('⏳ جاري حذف جميع العملاء المستوردين...', 'orange');
        await apiFetch('/imported-contacts', { method: 'DELETE' });
        log('✅ تم حذف جميع العملاء المستوردين بنجاح.', 'green');
        loadImportedClients();
    } catch (err) {
        log(`❌ خطأ أثناء الحذف: ${err.message}`, 'red');
    }
}

function sendSelectedPromo() {
    const phone = uiElements.phoneInput.value.trim();
    if (!phone) return alert('يرجى إدخال رقم هاتف.');
    if (!isWhatsAppReady()) return;
    sendPromo(phone, selectedPromoId);
}

function testMessage() {
    const adminNumber = "212619145177"; // رقمك الخاص
    if (!isWhatsAppReady()) return;
    log(`🧪 إرسال رسالة تجريبية إلى رقمك ${adminNumber}...`, 'blue');
    sendPromo(adminNumber, selectedPromoId);
}

// ... باقي الدوال ديالك من بعد ...
// selectPromo, deleteClient, isWhatsAppReady, sendPromo, sendPromoSequentially, handleLogout, log
// هاد الدوال كتبقى كيفما هي عندك
