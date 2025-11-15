// ================================================================= //
// ============ 0. معالجة التوكن عند الدخول عبر جوجل ============ //
// ================================================================= //
const urlParams = new URLSearchParams(window.location.search);
const tokenFromUrl = urlParams.get('token');
if (tokenFromUrl) {
    localStorage.setItem('authToken', tokenFromUrl);
    // ننظف الرابط من التوكن ليبقى الرابط نظيفاً
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
const adminNumber = "212619145177"; // يمكنك تغيير هذا الرقم

// تعريف عناصر الواجهة لتسهيل الوصول إليها
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
}

// ================================================================= //
// =============== 4. الاتصال بواتساب عبر Socket.IO ================ //
// ================================================================= //
function initializeWhatsAppConnection() {
    socket = io();
    
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
// ============= 5. دالة مركزية للتواصل مع الـ API (نسخة محدثة) ================= //
// ================================================================= //
async function apiFetch(url, options = {}) {
    const headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    
    try {
        const response = await fetch(url, { ...options, headers });
        
        // التعامل مع انتهاء صلاحية الجلسة (Token)
        if (response.status === 401) {
            handleLogout(true); // تسجيل الخروج الإجباري
            throw new Error('فشل التحقق من الهوية، انتهت الجلسة.');
        }

        // --- [ هذا هو التعديل الأهم والجديد الذي طلبته ] ---
        // التعامل مع انتهاء صلاحية الاشتراك
        if (response.status === 403) {
            const errorData = await response.json().catch(() => ({}));
            if (errorData.subscriptionExpired) {
                alert('انتهت صلاحية اشتراكك أو الفترة التجريبية. سيتم توجيهك لصفحة التفعيل.');
                window.location.replace('/activate.html'); // الذهاب لصفحة التفعيل
                throw new Error('Subscription expired'); // إيقاف الكود لتجنب أخطاء إضافية
            }
        }
        // --- [ نهاية التعديل ] ---

        if (!response.ok) {
            const errJson = await response.json().catch(() => null);
            throw new Error(errJson ? errJson.message : `خطأ من الخادم: ${response.statusText}`);
        }
        
        const text = await response.text();
        return text ? JSON.parse(text) : {}; // تجنب الخطأ إذا كان الجواب فارغاً
    
    } catch (error) {
        // إذا لم يكن الخطأ بسبب إعادة التوجيه، قم بتسجيله في الواجهة
        if (error.message !== 'Subscription expired') {
            log(`❌ حدث خطأ في الشبكة أو الخادم: ${error.message}`, 'red');
        }
        throw error; // إرجاع الخطأ ليتم التعامل معه في الدوال الأخرى إذا لزم الأمر
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

async function loadClients() {
    try {
        clients = await apiFetch("/contacts") || [];
        displayClients(uiElements.clientsList, clients, 'contacts');
    } catch (err) { /* يتم التعامل مع الخطأ داخل apiFetch وإعادة التوجيه إذا لزم الأمر */ }
}

async function loadImportedClients() {
    try {
        importedClients = await apiFetch("/imported-contacts") || [];
        displayClients(uiElements.importedClientsList, importedClients, 'imported');
    } catch (err) { /* يتم التعامل مع الخطأ داخل apiFetch */ }
}

async function loadPromos() {
    try {
        promos = await apiFetch("/promos") || [];
        displayPromos();
    } catch (err) { /* يتم التعامل مع الخطأ داخل apiFetch */ }
}

function displayClients(container, list, type) {
    container.innerHTML = "";
    const title = type === 'contacts' ? 'جهات الاتصال' : 'الأرقام المستوردة';
    if (!list || !list.length) {
        container.innerHTML = `<p class="empty-list">قائمة ${title} فارغة.</p>`;
        return;
    }
    list.forEach(client => {
        const div = document.createElement("div");
        div.className = 'client-item';
        div.innerHTML = `<span>${client.name || ''} <strong>+${client.phone}</strong></span>`;
        container.appendChild(div);
    });
}

function displayPromos() {
    uiElements.promosList.innerHTML = "";
    if (!promos || !promos.length) {
        uiElements.promosList.innerHTML = `<p class="empty-list">لم تقم بإضافة أي عروض بعد.</p>`;
        return;
    }
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
            </div>
        `;
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
// الكود الكامل للدوال لتجنب أي نقص
async function addNewPromo() { const text = uiElements.newPromoText.value.trim(); const imageFile = uiElements.newPromoImage.files[0]; if (!text || !imageFile) { return alert('يرجى إدخال نص واختيار صورة.'); } const formData = new FormData(); formData.append('text', text); formData.append('image', imageFile); try { await apiFetch('/addPromo', { method: 'POST', body: formData }); log("✅ تم إضافة العرض بنجاح!", 'green'); uiElements.newPromoText.value = ''; uiElements.newPromoImage.value = ''; loadPromos(); } catch (err) {} }
async function importCSV() { const file = uiElements.csvFileInput.files[0]; if (!file) { return alert('يرجى اختيار ملف CSV.'); } const formData = new FormData(); formData.append('csv', file); try { const result = await apiFetch('/import-csv', { method: 'POST', body: formData }); log(`✅ ${result.message} (تم استيراد ${result.imported} رقم جديد).`, 'green'); uiElements.csvFileInput.value = ''; loadImportedClients(); } catch (err) {} }
function selectPromo(id) { selectedPromoId = id; log(`🔵 تم اختيار العرض #${id}`, "blue"); document.querySelectorAll('.promo').forEach(p => p.classList.remove('selected')); document.getElementById(`promo-${id}`).classList.add('selected'); }
async function deletePromo(id) { if (!confirm("هل أنت متأكد من حذف هذا العرض؟")) return; try { await apiFetch(`/deletePromo/${id}`, { method: "DELETE" }); log(`✅ تم حذف العرض بنجاح.`, "green"); if (selectedPromoId === id) selectedPromoId = null; loadPromos(); } catch (err) {} }

// ================================================================= //
// ========================= 8. وظائف الإرسال ======================= //
// ================================================================= //
function sendPromo(phone, promoId, fromImported) { /* ... الكود يبقى كما هو ... */ }
function sendSelectedPromo() { /* ... الكود يبقى كما هو ... */ }
function testMessage() { /* ... الكود يبقى كما هو ... */ }
async function sendPromoSequentially(list, fromImported) { /* ... الكود يبقى كما هو ... */ }
// الكود الكامل للدوال لتجنب أي نقص
function sendPromo(phone, promoId, fromImported) { if (!isWhatsappReady || !socket) { alert('❌ واتساب غير متصل. يرجى الانتظار.'); return; } log(`⏳ جاري إرسال العرض إلى +${phone}...`, 'blue'); socket.emit('send-promo', { phone, promoId, fromImported }); }
function sendSelectedPromo() { const phone = uiElements.phoneInput.value.trim(); if (!phone) return alert("الرجاء إدخال رقم هاتف."); if (!selectedPromoId) return alert("الرجاء اختيار عرض أولاً."); sendPromo(phone, selectedPromoId, false); }
function testMessage() { if (!selectedPromoId) return alert("الرجاء اختيار عرض لإرساله كتجربة."); sendPromo(adminNumber, selectedPromoId, false); }
async function sendPromoSequentially(list, fromImported) { if (!selectedPromoId) return alert("الرجاء اختيار عرض أولاً."); if (!list || list.length === 0) return alert("القائمة فارغة."); if (!isWhatsappReady) return alert("يرجى انتظار اتصال واتساب أولاً."); if (!confirm(`هل أنت متأكد من إرسال العرض لـ ${list.length} رقم؟`)) return; uiElements.sendSequentiallyClientsBtn.disabled = true; uiElements.sendSequentiallyImportedBtn.disabled = true; log(`🚀 بدأت حملة الإرسال لـ ${list.length} رقم.`, 'purple'); for (let i = 0; i < list.length; i++) { const client = list[i]; if (!isWhatsappReady) { log('🛑 توقفت الحملة، انقطع اتصال واتساب.', 'red'); break; } sendPromo(client.phone, selectedPromoId, fromImported); if (i < list.length - 1) { const delay = 30000 + Math.random() * 30000; log(`⏳ انتظار ${Math.round(delay/1000)} ثانية قبل الإرسال التالي...`, "orange"); await new Promise(resolve => setTimeout(resolve, delay)); } } log('🎉 انتهت حملة الإرسال بنجاح.', 'green'); uiElements.sendSequentiallyClientsBtn.disabled = false; uiElements.sendSequentiallyImportedBtn.disabled = false; }

// ================================================================= //
// ====================== 9. وظائف مساعدة أخرى ====================== //
// ================================================================= //
function handleLogout(isForced = false) {
    if (!isForced && !confirm("هل أنت متأكد من رغبتك في تسجيل الخروج؟")) return;
    if(isForced) {
        alert("انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً.");
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
