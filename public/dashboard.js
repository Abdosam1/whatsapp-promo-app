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
const adminNumber = "212619145177"; // رقمك الخاص للاختبار

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
    socket = io({ 
        reconnection: true, 
        reconnectionAttempts: 5,
        auth: { token } // **مهم** لإرسال التوكن عند الاتصال
    });
    
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

async function loadClients() {
    try {
        const data = await apiFetch("/contacts");
        clients = Array.isArray(data) ? data : [];
        displayClients(uiElements.clientsList, clients, 'clientsList');
    } catch (err) {
        log(`❌ خطأ في تحميل العملاء: ${err.message}`, "red");
    }
}

async function loadImportedClients() {
    try {
        const data = await apiFetch("/imported-contacts");
        importedClients = Array.isArray(data) ? data : [];
        displayClients(uiElements.importedClientsList, importedClients, 'importedClientsList');
    } catch (err) {
        log(`❌ خطأ في تحميل العملاء المستوردين: ${err.message}`, "red");
    }
}

async function loadPromos() {
    try {
        const data = await apiFetch("/promos");
        promos = Array.isArray(data) ? data : [];
        displayPromos();
    } catch (err) {
        log("❌ خطأ في تحميل العروض الترويجية", "red");
    }
}

function displayClients(container, list, containerId) {
    container.innerHTML = "";
    if (!list.length) {
        container.innerHTML = "<p class='empty-list-message'>لا يوجد عملاء في هذه القائمة.</p>";
        return;
    }
    list.forEach(client => {
        const clientRow = createClientRow(client, containerId);
        container.appendChild(clientRow);
    });
}

function createClientRow(client, containerId) {
    const div = document.createElement("div");
    div.className = 'client-row';
    const infoSpan = document.createElement("span");
    infoSpan.textContent = `${client.name || "بدون اسم"} - +${client.phone}`;
    const deleteButton = document.createElement("button");
    deleteButton.className = 'btn-danger-small';
    deleteButton.textContent = 'حذف';
    deleteButton.addEventListener('click', () => deleteClient(client.id, containerId === 'clientsList' ? false : true));
    div.appendChild(infoSpan);
    div.appendChild(deleteButton);
    return div;
}

function displayPromos() {
    uiElements.promosList.innerHTML = "";
    if (!promos.length) {
        uiElements.promosList.innerHTML = "<p class='empty-list-message'>لم تقم بإضافة أي عروض بعد.</p>";
        return;
    }
    promos.forEach(promo => {
        const promoCard = createPromoCard(promo);
        uiElements.promosList.appendChild(promoCard);
    });
}

function createPromoCard(promo) {
    const div = document.createElement("div"); div.className = "promo"; div.id = `promo-${promo.id}`;
    const img = document.createElement("img"); img.src = `promos/${promo.image}`; img.alt = "صورة العرض";
    const p = document.createElement("p"); p.title = promo.text; p.textContent = promo.text.length > 50 ? `${promo.text.substr(0, 50)}...` : promo.text;
    const buttonsDiv = document.createElement("div"); buttonsDiv.className = "promo-buttons";
    const selectButton = document.createElement("button"); selectButton.type = 'button'; selectButton.className = 'btn-select'; selectButton.innerHTML = `<i class="fas fa-check"></i> اختيار`; selectButton.addEventListener('click', () => selectPromo(promo.id));
    const deleteButton = document.createElement("button"); deleteButton.type = 'button'; deleteButton.className = 'btn-delete'; deleteButton.innerHTML = `<i class="fas fa-trash"></i> حذف`; deleteButton.addEventListener('click', () => deletePromo(promo.id));
    buttonsDiv.appendChild(selectButton); buttonsDiv.appendChild(deleteButton);
    div.appendChild(img); div.appendChild(p); div.appendChild(buttonsDiv);
    return div;
}

// ================================================================= //
// =================== 7. وظائف التفاعل مع المستخدم ================= //
// ================================================================= //
async function addNewPromo() {
    const text = uiElements.newPromoText.value.trim();
    const image = uiElements.newPromoImage.files[0];
    if (!text || !image) return alert('يرجى إدخال نص العرض واختيار صورة.');
    const formData = new FormData();
    formData.append('text', text); formData.append('image', image);
    uiElements.addNewPromoBtn.disabled = true;
    try {
        log('⏳ جاري إضافة العرض الجديد...', 'orange');
        await apiFetch('/promos', { method: 'POST', body: formData });
        log('✅ تم إضافة العرض بنجاح!', 'green');
        uiElements.newPromoText.value = ''; uiElements.newPromoImage.value = '';
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
    if (!confirm("هل أنت متأكد من حذف جميع العملاء المستوردين؟")) return;
    try {
        log('⏳ جاري حذف جميع العملاء المستوردين...', 'orange');
        await apiFetch('/imported-contacts', { method: 'DELETE' });
        log('✅ تم حذف جميع العملاء المستوردين بنجاح.', 'green');
        loadImportedClients();
    } catch (err) {
        log(`❌ خطأ أثناء الحذف: ${err.message}`, 'red');
    }
}

function selectPromo(id) {
    selectedPromoId = id;
    log(`🔵 تم اختيار العرض #${id} للإرسال.`, "blue");
    document.querySelectorAll('.promo').forEach(p => p.classList.remove('selected'));
    document.getElementById(`promo-${id}`).classList.add('selected');
}

async function deletePromo(id) {
    if (!confirm("هل أنت متأكد من حذف هذا العرض؟")) return;
    try {
        await apiFetch(`/promos/${id}`, { method: "DELETE" });
        log(`✅ تم حذف العرض بنجاح.`, "green");
        loadPromos();
    } catch (err) {
        alert(`❌ خطأ أثناء حذف العرض: ${err.message}`);
    }
}

async function deleteClient(id, isImported) {
    if (!confirm("هل أنت متأكد من حذف هذا العميل؟")) return;
    const url = isImported ? `/imported-contacts/${id}` : `/contacts/${id}`;
    try {
        await apiFetch(url, { method: "DELETE" });
        log(`✅ تم حذف العميل بنجاح.`, "green");
        isImported ? loadImportedClients() : loadClients();
    } catch (err) {
        alert(`❌ خطأ أثناء الحذف: ${err.message}`);
    }
}

// ================================================================= //
// ========================= 8. وظائف الإرسال ======================= //
// ================================================================= //
function isWhatsAppReady() { /* ... */ return true; }
function sendPromo(phone, promoId) { /* ... */ }
function sendSelectedPromo() { /* ... */ }
function testMessage() { /* ... */ }
async function sendPromoSequentially(list, fromImported) { /* ... */ }

// ================================================================= //
// ====================== 9. وظائف مساعدة أخرى ====================== //
// ================================================================= //
async function handleLogout() { /* ... */ }
function log(message, color = "black") { /* ... */ }
