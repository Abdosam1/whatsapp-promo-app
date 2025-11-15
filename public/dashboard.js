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
const adminNumber = "212619145177"; // يمكنك تغيير هذا الرقم

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
    uiElements.logoutBtn.addEventListener('click', handleLogout);
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
// ============= 5. دالة مركزية للتواصل مع الـ API ================= //
// ================================================================= //
async function apiFetch(url, options = {}) {
    const headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    
    const response = await fetch(url, { ...options, headers });
    
    if (response.status === 401) {
        handleLogout(true);
        throw new Error('فشل التحقق من الهوية');
    }
    if (!response.ok) {
        const errText = await response.text();
        try {
            const errJson = JSON.parse(errText);
            throw new Error(errJson.message);
        } catch {
            throw new Error(`خطأ من الخادم: ${response.statusText} (${errText})`);
        }
    }
    
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
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
        clients = await apiFetch("/contacts") || [];
        displayClients(uiElements.clientsList, clients);
    } catch (err) { log(`❌ خطأ تحميل العملاء: ${err.message}`, "red"); }
}

async function loadImportedClients() {
    try {
        importedClients = await apiFetch("/imported-contacts") || [];
        displayClients(uiElements.importedClientsList, importedClients);
    } catch (err) { log(`❌ خطأ تحميل العملاء المستوردين: ${err.message}`, "red"); }
}

async function loadPromos() {
    try {
        promos = await apiFetch("/promos") || [];
        displayPromos();
    } catch (err) { log(`❌ خطأ تحميل العروض: ${err.message}`, "red"); }
}

function displayClients(container, list) {
    container.innerHTML = "";
    if (!list || !list.length) return container.innerHTML = "<p>القائمة فارغة.</p>";
    list.forEach(client => {
        const div = document.createElement("div");
        div.innerHTML = `<span>${client.name || ''} +${client.phone}</span>`;
        container.appendChild(div);
    });
}

function displayPromos() {
    uiElements.promosList.innerHTML = "";
    if (!promos || !promos.length) return uiElements.promosList.innerHTML = "<p>لم تقم بإضافة أي عروض.</p>";
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
async function addNewPromo() {
    const text = uiElements.newPromoText.value.trim();
    const imageFile = uiElements.newPromoImage.files[0]; 
    if (!text || !imageFile) {
        return alert('يرجى إدخال نص واختيار صورة.');
    }
    
    const formData = new FormData();
    formData.append('text', text);
    formData.append('image', imageFile); 

    try {
        await apiFetch('/addPromo', { method: 'POST', body: formData });
        alert("✅ تم إضافة العرض بنجاح!");
        uiElements.newPromoText.value = ''; 
        uiElements.newPromoImage.value = '';
        loadPromos();
    } catch (err) { 
        alert(`❌ فشل في إضافة العرض: ${err.message}`); 
    }
}

async function importCSV() {
    const file = uiElements.csvFileInput.files[0]; 
    if (!file) {
        return alert('يرجى اختيار ملف CSV.');
    }
    
    const formData = new FormData();
    formData.append('csv', file);

    try {
        const result = await apiFetch('/import-csv', { method: 'POST', body: formData });
        alert(`✅ ${result.message} (تم استيراد ${result.imported} رقم جديد).`);
        uiElements.csvFileInput.value = '';
        loadImportedClients();
    } catch (err) { 
        alert(`❌ فشل في استيراد الملف: ${err.message}`); 
    }
}

function selectPromo(id) {
    selectedPromoId = id;
    log(`🔵 تم اختيار العرض #${id}`, "blue");
    document.querySelectorAll('.promo').forEach(p => p.classList.remove('selected'));
    document.getElementById(`promo-${id}`).classList.add('selected');
}

async function deletePromo(id) {
    if (!confirm("هل أنت متأكد من حذف هذا العرض؟")) return;
    try {
        await apiFetch(`/deletePromo/${id}`, { method: "DELETE" });
        log(`✅ تم حذف العرض بنجاح.`, "green");
        if (selectedPromoId === id) selectedPromoId = null;
        loadPromos();
    } catch (err) { log(`❌ خطأ الحذف: ${err.message}`, 'red'); }
}

// ================================================================= //
// ========================= 8. وظائف الإرسال ======================= //
// ================================================================= //
function sendPromo(phone, promoId, fromImported) {
    if (!isWhatsappReady || !socket) {
        alert('❌ واتساب غير متصل. يرجى الانتظار.');
        return false;
    }
    log(`⏳ جاري إرسال العرض إلى +${phone}...`, 'blue');
    socket.emit('send-promo', { phone, promoId, fromImported });
    return true;
}

function sendSelectedPromo() {
    const phone = uiElements.phoneInput.value.trim();
    if (!phone) return alert("الرجاء إدخال رقم هاتف.");
    if (!selectedPromoId) return alert("الرجاء اختيار عرض أولاً.");
    sendPromo(phone, selectedPromoId, false);
}

function testMessage() {
    if (!selectedPromoId) return alert("الرجاء اختيار عرض لإرساله كتجربة.");
    sendPromo(adminNumber, selectedPromoId, false);
}

async function sendPromoSequentially(list, fromImported) {
    if (!selectedPromoId) return alert("الرجاء اختيار عرض أولاً.");
    if (!list || list.length === 0) return alert("القائمة فارغة.");
    if (!isWhatsappReady) return alert("يرجى انتظار اتصال واتساب أولاً.");
    if (!confirm(`هل أنت متأكد من إرسال العرض لـ ${list.length} رقم؟`)) return;

    uiElements.sendSequentiallyClientsBtn.disabled = true;
    uiElements.sendSequentiallyImportedBtn.disabled = true;
    log(`🚀 بدأت حملة الإرسال لـ ${list.length} رقم.`, 'purple');

    for (let i = 0; i < list.length; i++) {
        const client = list[i];
        if (!isWhatsappReady) {
            log('🛑 توقفت الحملة، انقطع اتصال واتساب.', 'red');
            break;
        }
        
        if (sendPromo(client.phone, selectedPromoId, fromImported)) {
            if (i < list.length - 1) {
                const delay = 30000 + Math.random() * 30000;
                log(`⏳ انتظار ${Math.round(delay/1000)} ثانية...`, "orange");
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } else {
            break;
        }
    }

    log('🎉 انتهت حملة الإرسال.', 'green');
    uiElements.sendSequentiallyClientsBtn.disabled = false;
    uiElements.sendSequentiallyImportedBtn.disabled = false;
}

// ================================================================= //
// ====================== 9. وظائف مساعدة أخرى ====================== //
// ================================================================= //
async function handleLogout(force = false) {
    if (!force && !confirm("هل أنت متأكد؟")) return;
    localStorage.removeItem('authToken');
    window.location.replace('index.html');
}

function log(message, color = "black") {
    const p = document.createElement("p");
    p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    p.style.color = color;
    uiElements.logsContainer.prepend(p);
}
