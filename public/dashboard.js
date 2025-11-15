// ================================================================= //
// ============ 0. معالجة التوكن عند الدخول عبر جوجل ============ //
// ================================================================= //
const urlParams = new URLSearchParams(window.location.search);
const tokenFromUrl = urlParams.get('token');
if (tokenFromUrl) {
    localStorage.setItem('authToken', tokenFromUrl);
    // تنظيف الرابط من التوكن
    window.history.replaceState({}, document.title, "/dashboard.html");
}

// ================================================================= //
// ==================== 1. التحقق من الأمان أولاً =================== //
// ================================================================= //
const token = localStorage.getItem('authToken');
if (!token) {
    // إذا لم يكن هناك توكن، أعد التوجيه إلى صفحة الدخول
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
let isWhatsappReady = false; // متغير لتتبع حالة اتصال واتساب
const adminNumber = "212619145177"; // رقمك الخاص للاختبار

// الوصول إلى عناصر واجهة المستخدم
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

// تهيئة جميع مستمعي الأحداث
function initializeEventListeners() {
    uiElements.logoutBtn.addEventListener('click', handleLogout);
    uiElements.addNewPromoBtn.addEventListener('click', addNewPromo);
    uiElements.importCsvBtn.addEventListener('click', importCSV);
    uiElements.sendSequentiallyClientsBtn.addEventListener('click', () => sendPromoSequentially(clients, false));
    uiElements.sendSequentiallyImportedBtn.addEventListener('click', () => sendPromoSequentially(importedClients, true));
    // ملاحظة: وظيفة حذف الكل تحتاج إلى مسار API في الخادم
    // uiElements.deleteAllImportedBtn.addEventListener('click', deleteAllImportedClients); 
    uiElements.sendSelectedPromoBtn.addEventListener('click', sendSelectedPromo);
    uiElements.testMessageBtn.addEventListener('click', testMessage);
}


// ================================================================= //
// =============== 4. الاتصال بواتساب عبر Socket.IO ================ //
// ================================================================= //
function initializeWhatsAppConnection() {
    socket = io({ reconnection: true, reconnectionAttempts: 5 });
    
    socket.on('connect', () => {
        log('🔌 متصل بالخادم، جاري طلب الاتصال بواتساب...', 'blue');
        if (token) socket.emit('init-whatsapp', token);
    });
    
    socket.on('qr', (qr) => {
        isWhatsappReady = false;
        uiElements.statusMessage.textContent = 'يرجى مسح هذا الـ QR Code للاتصال:';
        uiElements.qrcodeCanvas.style.display = 'block';
        QRCode.toCanvas(uiElements.qrcodeCanvas, qr, { width: 256 }, (err) => {
            if (err) console.error(err);
        });
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
            if (status.error) {
                uiElements.statusCard.style.backgroundColor = '#f8d7da';
            }
        }
    });

    socket.on('send-promo-status', (status) => {
        if (status.success) {
            log(`✅ تم إرسال العرض بنجاح إلى +${status.phone}`, "green");
        } else {
            log(`❌ فشل الإرسال إلى +${status.phone}: ${status.error}`, "red");
        }
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
    const headers = { ...options.headers };
    // إضافة توكن المصادقة لكل طلب
    headers['Authorization'] = `Bearer ${token}`;
    // تعيين نوع المحتوى تلقائياً إلا إذا كان FormData
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
        // معالجة الأخطاء من الخادم
        const errorData = await response.json().catch(() => ({ message: `Server error: ${response.statusText}` }));
        // إذا فشل تسجيل الخروج بسبب التوكن، قم بتسجيل الخروج بالقوة
        if (response.status === 401) {
            handleLogout(true);
        }
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

// --- تعديل: تم إضافة /api لجميع الروابط ---
async function loadClients() {
    try {
        clients = await apiFetch("/api/contacts") || [];
        displayClients(uiElements.clientsList, clients, false);
    } catch (err) { log(`❌ خطأ في تحميل العملاء: ${err.message}`, "red"); }
}

async function loadImportedClients() {
    try {
        importedClients = await apiFetch("/api/imported-contacts") || [];
        displayClients(uiElements.importedClientsList, importedClients, true);
    } catch (err) { log(`❌ خطأ في تحميل العملاء المستوردين: ${err.message}`, "red"); }
}

async function loadPromos() {
    try {
        promos = await apiFetch("/api/promos") || [];
        displayPromos();
    } catch (err) { log(`❌ خطأ في تحميل العروض: ${err.message}`, "red"); }
}

function displayClients(container, list, isImported) {
    container.innerHTML = "";
    if (!list || !list.length) {
        container.innerHTML = "<p>لا يوجد عملاء في هذه القائمة.</p>";
        return;
    }
    list.forEach(client => {
        const div = document.createElement("div");
        div.innerHTML = `<span>${client.name || ''} +${client.phone}</span>`;
        container.appendChild(div);
    });
}

function displayPromos() {
    uiElements.promosList.innerHTML = "";
    if (!promos || !promos.length) {
        uiElements.promosList.innerHTML = "<p>لم تقم بإضافة أي عروض بعد.</p>";
        return;
    }
    promos.forEach(promo => {
        const div = document.createElement("div");
        div.className = "promo";
        div.id = `promo-${promo.id}`;
        div.innerHTML = `
            <img src="promos/${promo.image}" alt="صورة العرض">
            <p title="${promo.text}">${promo.text.length > 50 ? `${promo.text.substr(0, 50)}...` : promo.text}</p>
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
    const image = uiElements.newPromoImage.files[0];
    if (!text || !image) return alert('يرجى إدخال نص العرض واختيار صورة.');
    
    const formData = new FormData();
    formData.append('text', text);
    formData.append('image', image);

    uiElements.addNewPromoBtn.disabled = true;
    try {
        log('⏳ جاري إضافة العرض الجديد...', 'orange');
        // --- تعديل: تم تصحيح المسار ---
        await apiFetch('/api/addPromo', { method: 'POST', body: formData });
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
    // --- تعديل: تم تصحيح اسم الحقل ليطابق الخادم ---
    formData.append('csv', file);

    uiElements.importCsvBtn.disabled = true;
    try {
        log('⏳ جاري استيراد الأرقام...', 'orange');
        // --- تعديل: تم تصحيح المسار ---
        const result = await apiFetch('/api/import-csv', { method: 'POST', body: formData });
        log(`✅ ${result.message} (تمت إضافة ${result.imported} رقم جديد).`, 'green');
        uiElements.csvFileInput.value = '';
        loadImportedClients();
    } catch (err) {
        log(`❌ فشل استيراد الملف: ${err.message}`, 'red');
    } finally {
        uiElements.importCsvBtn.disabled = false;
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
        // --- تعديل: تم تصحيح المسار ---
        await apiFetch(`/api/deletePromo/${id}`, { method: "DELETE" });
        log(`✅ تم حذف العرض بنجاح.`, "green");
        if (selectedPromoId === id) selectedPromoId = null;
        loadPromos();
    } catch (err) {
        log(`❌ خطأ أثناء حذف العرض: ${err.message}`, 'red');
    }
}

// ================================================================= //
// ========================= 8. وظائف الإرسال ======================= //
// ================================================================= //

// دالة مركزية لإرسال العرض عبر Socket
function sendPromo(phone, promoId, fromImported) {
    if (!isWhatsappReady) {
        log('⚠️ واتساب غير متصل. يرجى الانتظار أو إعادة فحص الـ QR Code.', 'orange');
        return;
    }
    if (!socket) {
        log('⚠️ خطأ في الاتصال بالخادم.', 'red');
        return;
    }
    log(`⏳ جاري إرسال العرض إلى +${phone}...`, 'blue');
    socket.emit('send-promo', { phone, promoId, fromImported, token });
}

// إرسال العرض المحدد إلى الرقم المدخل
function sendSelectedPromo() {
    const phone = uiElements.phoneInput.value.trim();
    if (!phone) return alert("الرجاء إدخال رقم هاتف.");
    if (!selectedPromoId) return alert("الرجاء اختيار عرض أولاً.");
    sendPromo(phone, selectedPromoId, false);
}

// إرسال رسالة تجريبية إلى رقمك الخاص
function testMessage() {
    if (!selectedPromoId) return alert("الرجاء اختيار عرض أولاً لإرساله كرسالة تجريبية.");
    log(`🧪 إرسال رسالة تجريبية إلى رقمك +${adminNumber}...`, 'blue');
    sendPromo(adminNumber, selectedPromoId, false);
}

// إرسال العروض بشكل متتابع لقائمة كاملة
async function sendPromoSequentially(list, fromImported) {
    if (!selectedPromoId) return alert("الرجاء اختيار عرض أولاً لإرساله للجميع.");
    if (!list || list.length === 0) return alert("القائمة فارغة، لا يوجد أرقام للإرسال إليها.");
    if (!confirm(`هل أنت متأكد من أنك تريد إرسال العرض المحدد إلى ${list.length} رقم؟`)) return;

    // تعطيل الأزرار لمنع الإرسال المزدوج
    uiElements.sendSequentiallyClientsBtn.disabled = true;
    uiElements.sendSequentiallyImportedBtn.disabled = true;
    log(`🚀 بدأت حملة الإرسال لـ ${list.length} رقم.`, 'purple');

    for (let i = 0; i < list.length; i++) {
        const client = list[i];
        if (!isWhatsappReady) {
            log('🛑 توقفت الحملة لأن اتصال واتساب انقطع.', 'red');
            break; // الخروج من الحلقة إذا انقطع الاتصال
        }
        
        log(`(${i + 1}/${list.length}) جاري الإرسال إلى +${client.phone}...`, 'blue');
        sendPromo(client.phone, selectedPromoId, fromImported);

        // انتظار استجابة الخادم قبل الانتقال للرقم التالي
        // الخادم نفسه لديه تأخير، هذا فقط للتأكيد
        await new Promise(resolve => {
            const timeout = setTimeout(() => resolve(), 30000); // حد أقصى للانتظار 30 ثانية
            socket.once('send-promo-status', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    log('🎉 انتهت حملة الإرسال.', 'green');
    // إعادة تفعيل الأزرار
    uiElements.sendSequentiallyClientsBtn.disabled = false;
    uiElements.sendSequentiallyImportedBtn.disabled = false;
}

// ================================================================= //
// ====================== 9. وظائف مساعدة أخرى ====================== //
// ================================================================= //
async function handleLogout(force = false) {
    if (!force && !confirm("هل أنت متأكد من تسجيل الخروج؟")) return;
    try {
        await apiFetch('/api/whatsapp/logout', { method: 'POST' });
    } catch (error) {
        console.error("Logout failed, but proceeding:", error.message);
    } finally {
        localStorage.removeItem('authToken');
        window.location.replace('index.html');
    }
}

function log(message, color = "black") {
    const p = document.createElement("p");
    p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    p.style.color = color;
    p.style.margin = '5px 0';
    p.style.borderBottom = '1px solid #eee';
    p.style.paddingBottom = '5px';
    uiElements.logsContainer.appendChild(p);
    // التمرير التلقائي للأسفل
    uiElements.logsContainer.scrollTop = uiElements.logsContainer.scrollHeight;
}
