// ================================================================= //
// ==================== 1. التحقق من الأمان أولاً =================== //
// ================================================================= //
// هذا الكود يعمل فوراً عند تحميل الصفحة. إذا لم يكن هناك توكن،
// يتم توجيه المستخدم لصفحة البداية قبل تنفيذ أي شيء آخر.
const token = localStorage.getItem('authToken');
if (!token) {
    // نستخدم .replace() لمنع المستخدم من العودة للصفحة السابقة عبر زر "Back".
    window.location.replace('index.html');
}


// ================================================================= //
// ======================== 2. إعدادات عامة ======================== //
// ================================================================= //

// --- إدارة الحالة (State) ---
// نخزن البيانات الديناميكية هنا لتكون متاحة في كل التطبيق.
let clients = [];
let importedClients = [];
let promos = [];
let selectedPromoId = null;
let socket = null;
const adminNumber = "212619145177"; // رقمك الخاص للاختبار

// --- عناصر الواجهة الرسومية (UI Elements) ---
// نجمع كل العناصر التي سنتعامل معها في كائن واحد لتسهيل الوصول إليها.
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
    sendToAllClientsBtn: document.getElementById('sendToAllClientsBtn'),
    sendToAllImportedBtn: document.getElementById('sendToAllImportedBtn'),
};


// ================================================================= //
// ==================== 3. نقطة انطلاق التطبيق ===================== //
// ================================================================= //
document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    checkSubscriptionAndInitialize();
});

/**
 * دالة مركزية لإضافة كل الـ Event Listeners عند بدء تشغيل الصفحة.
 */
function initializeEventListeners() {
    if (uiElements.logoutBtn) {
        uiElements.logoutBtn.addEventListener('click', handleLogout);
    }
    // يمكنك إضافة أي event listeners أخرى هنا بنفس الطريقة
    // مثال: document.getElementById('someButton').addEventListener('click', someFunction);
}

/**
 * يتحقق من حالة اشتراك المستخدم ثم يبدأ الاتصال بواتساب.
 */
async function checkSubscriptionAndInitialize() {
    // إخفاء المحتوى الرئيسي في البداية لتجنب ظهور عناصر غير مكتملة.
    uiElements.mainContainer.style.display = 'none';
    uiElements.statusCard.style.display = 'none';

    try {
        const status = await apiFetch(`/api/check-status?_=${new Date().getTime()}`); // Cache bust
        if (status.active) {
            console.log("Subscription is active. Initializing...");
            uiElements.mainContainer.style.display = 'block';
            uiElements.statusCard.style.display = 'block';
            initializeWhatsAppConnection();
        } else {
            // إذا لم يكن الاشتراك فعالاً، يتم التوجيه مباشرة لصفحة التفعيل.
            console.log("Subscription is inactive. Redirecting...");
            window.location.href = 'activate.html';
        }
    } catch (error) {
        // سيتم التعامل مع أخطاء التوكن والاشتراك داخل `apiFetch` نفسها.
        // هذا الـ catch مخصص لأخطاء الشبكة أو الأخطاء غير المتوقعة.
        console.error("Failed to check status:", error);
        if (error.message !== 'Subscription has expired' && error.message !== 'Authentication failed') {
            log('❌ خطأ في الاتصال بالخادم، يرجى المحاولة مرة أخرى.', 'red');
        }
    }
}


// ================================================================= //
// =============== 4. الاتصال بواتساب عبر Socket.IO ================ //
// ================================================================= //
function initializeWhatsAppConnection() {
    socket = io({
        // إعادة الاتصال تلقائياً في حالة انقطاع الشبكة
        reconnection: true,
        reconnectionAttempts: 5
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
                loadInitialData(); // تحميل البيانات بعد نجاح الاتصال
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

    socket.on('disconnect', () => {
        log('🔌 تم قطع الاتصال بـ Socket.IO، حاول تحديث الصفحة.', 'orange');
    });
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

    try {
        const response = await fetch(url, { ...options, headers });

        if (response.status === 403) { // خطأ: الاشتراك منتهي
            window.location.replace('activate.html');
            throw new Error('Subscription has expired');
        }
        if (response.status === 401) { // خطأ: التوكن غير صالح أو منتهي
            handleLogout(false); // تسجيل الخروج بدون تنبيه
            throw new Error('Authentication failed');
        }
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: `خطأ في الخادم: ${response.statusText}` }));
            throw new Error(errorData.message || 'حدث خطأ غير معروف');
        }

        const contentType = response.headers.get("content-type");
        return contentType?.includes("application/json") ? response.json() : response.text();

    } catch (error) {
        // إعادة رمي الخطأ ليتم التعامل معه في المكان الذي تم استدعاء الدالة منه
        throw error;
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
        const data = await apiFetch("/contacts");
        clients = Array.isArray(data) ? data : [];
        displayClients(uiElements.clientsList, clients);
    } catch (err) {
        if (err.message !== 'Subscription has expired') log(`❌ خطأ في تحميل العملاء: ${err.message}`, "red");
    }
}

async function loadImportedClients() {
    try {
        const data = await apiFetch("/imported-contacts");
        importedClients = Array.isArray(data) ? data : [];
        displayClients(uiElements.importedClientsList, importedClients);
    } catch (err) {
        if (err.message !== 'Subscription has expired') log(`❌ خطأ في تحميل العملاء المستوردين: ${err.message}`, "red");
    }
}

async function loadPromos() {
    try {
        const data = await apiFetch("/promos");
        promos = Array.isArray(data) ? data : [];
        displayPromos();
    } catch (err) {
        if (err.message !== 'Subscription has expired') log("❌ خطأ في تحميل العروض الترويجية", "red");
    }
}

/**
 * دالة لعرض قائمة العملاء (العاديين أو المستوردين)
 * @param {HTMLElement} container - العنصر الذي سيحتوي على القائمة
 * @param {Array} list - قائمة العملاء
 */
function displayClients(container, list) {
    container.innerHTML = ""; // تفريغ القائمة قبل إعادة بنائها
    if (!list.length) {
        container.innerHTML = "<p class='empty-list-message'>لا يوجد عملاء في هذه القائمة حالياً.</p>";
        return;
    }
    list.forEach(client => {
        const clientRow = createClientRow(client, container.id);
        container.appendChild(clientRow);
    });
}

/**
 * [دالة مساعدة] تنشئ صف عميل واحد مع زر الحذف.
 * @returns {HTMLElement}
 */
function createClientRow(client, containerId) {
    const div = document.createElement("div");
    div.className = 'client-row';

    const infoSpan = document.createElement("span");
    infoSpan.textContent = `${client.name || "بدون اسم"} - +${client.phone}`;

    const deleteButton = document.createElement("button");
    deleteButton.className = 'btn-danger-small';
    deleteButton.textContent = 'حذف';
    deleteButton.addEventListener('click', () => deleteClient(containerId, client.id));

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

/**
 * [دالة مساعدة] تنشئ كارت عرض ترويجي واحد.
 * @returns {HTMLElement}
 */
function createPromoCard(promo) {
    const div = document.createElement("div");
    div.className = "promo";
    div.id = `promo-${promo.id}`;

    const img = document.createElement("img");
    img.src = `promos/${promo.image}`;
    img.alt = "صورة العرض";

    const p = document.createElement("p");
    p.title = promo.text;
    p.textContent = promo.text.length > 50 ? `${promo.text.substr(0, 50)}...` : promo.text;

    const buttonsDiv = document.createElement("div");
    buttonsDiv.className = "promo-buttons";

    const selectButton = document.createElement("button");
    selectButton.type = 'button';
    selectButton.className = 'btn-select';
    selectButton.innerHTML = `<i class="fas fa-check"></i> اختيار`;
    selectButton.addEventListener('click', () => selectPromo(promo.id));

    const deleteButton = document.createElement("button");
    deleteButton.type = 'button';
    deleteButton.className = 'btn-delete';
    deleteButton.innerHTML = `<i class="fas fa-trash"></i> حذف`;
    deleteButton.addEventListener('click', () => deletePromo(promo.id));

    buttonsDiv.appendChild(selectButton);
    buttonsDiv.appendChild(deleteButton);
    div.appendChild(img);
    div.appendChild(p);
    div.appendChild(buttonsDiv);
    return div;
}


// ================================================================= //
// =================== 7. وظائف التفاعل مع المستخدم ================= //
// ================================================================= //

function selectPromo(id) {
    selectedPromoId = id;
    log(`🔵 تم اختيار العرض #${id} للإرسال.`, "blue");
    document.querySelectorAll('.promo').forEach(p => p.classList.remove('selected'));
    document.getElementById(`promo-${id}`).classList.add('selected');
}

async function deleteClient(containerId, id) {
    if (!confirm("هل أنت متأكد من حذف هذا العميل؟")) return;
    const table = containerId === "clientsList" ? "clients" : "imported_clients";
    try {
        await apiFetch(`/delete/${table}/${id}`, { method: "DELETE" });
        log(`✅ تم حذف العميل بنجاح.`, "green");
        if (table === "clients") loadClients();
        else loadImportedClients();
    } catch (err) {
        alert(`❌ خطأ أثناء الحذف: ${err.message}`);
    }
}
// ... (باقي دوال التفاعل مثل addNewPromo, importCSV, etc. تبقى كما هي مع استخدام apiFetch)


// ================================================================= //
// ========================= 8. وظائف الإرسال ======================= //
// ================================================================= //
function isWhatsAppReady() {
    if (uiElements.mainContent.style.display !== 'block') {
        alert('❌ يرجى الانتظار حتى يتم الاتصال بواتساب بنجاح!');
        return false;
    }
    if (!selectedPromoId) {
        alert("⚠️ يرجى اختيار عرض ترويجي أولاً!");
        return false;
    }
    if (!socket || !socket.connected) {
        log('❌ خطأ: اتصال Socket غير جاهز. يرجى تحديث الصفحة.', 'red');
        return false;
    }
    return true;
}

function sendPromo(phone, promoId, fromImported = false) {
    const cleanPhone = phone.replace(/\D/g, "");
    log(`⏳ جاري إرسال العرض #${promoId} إلى +${cleanPhone}...`, 'orange');
    socket.emit('send-promo', { phone: cleanPhone, promoId, fromImported });
}

async function sendPromoSequentially(list, fromImported) {
    if (!isWhatsAppReady()) return;
    if (!list.length) return alert(`القائمة فارغة، لا يوجد عملاء للإرسال إليهم.`);
    
    // تعطيل الأزرار لمنع النقر المزدوج
    const button = fromImported ? uiElements.sendToAllImportedBtn : uiElements.sendToAllClientsBtn;
    button.disabled = true;
    button.textContent = 'جاري الإرسال...';
    
    log(`🚀 بدء الإرسال المتسلسل لـ ${list.length} عميل...`, 'blue');
    
    for (let i = 0; i < list.length; i++) {
        sendPromo(list[i].phone, selectedPromoId, fromImported);
        if (i < list.length - 1) {
            // انتظار عشوائي بين 30 و 60 ثانية لتجنب الحظر
            const delay = 30000 + Math.random() * 30000;
            log(`⏳ الانتظار لمدة ${Math.round(delay/1000)} ثانية قبل الإرسال التالي...`, "orange");
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    log(`🏁 اكتملت عملية الإرسال المتسلسل بنجاح!`, "green");
    
    // إعادة تفعيل الزر
    button.disabled = false;
    button.textContent = fromImported ? 'إرسال للكل (مستورد)' : 'إرسال للكل (جهات الاتصال)';
}

// ================================================================= //
// ====================== 9. وظائف مساعدة أخرى ====================== //
// ================================================================= //
async function handleLogout(showAlert = true) {
    log('🔄 جاري تسجيل الخروج...', 'blue');
    try {
        await apiFetch('/api/whatsapp/logout', { method: 'POST' });
        if (socket) socket.disconnect();
    } catch (e) {
        console.warn("Failed to delete WhatsApp session on server, but proceeding with client-side logout.", e);
    } finally {
        localStorage.removeItem('authToken');
        if(showAlert) alert('تم تسجيل الخروج بنجاح.');
        window.location.replace('index.html');
    }
}

function log(message, color = "black") {
    const entry = document.createElement("div");
    entry.style.color = color;
    // إضافة الطابع الزمني للرسالة
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    // إضافة الرسالة الجديدة في الأعلى
    uiElements.logsContainer.prepend(entry);
}
