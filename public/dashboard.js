// ================================================================= //
// ==================== 1. التحقق من الأمان أولاً =================== //
// ================================================================= //
const token = localStorage.getItem('authToken');
if (!token) {
    // التعديل: توجيه المستخدم مباشرة إلى صفحة تسجيل الدخول/Landing Page
    window.location.href = 'index.html'; 
}

// ================================================================= //
// ========================= 2. متغيرات عامة ======================= //
// ================================================================= //
let clients = [];
let importedClients = [];
let promos = [];
let selectedPromoId = null;
const adminNumber = "212619145177";
let socket = null; 

// ================================================================= //
// =========== 3. التحقق من الاشتراك وبدء التطبيق (المنطق المصحح) =========== //
// ================================================================= //
document.addEventListener('DOMContentLoaded', async () => {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => { // <--- إضافة async هنا
            // 1. تسجيل الخروج من واتساب (Backend) - حذف الجلسة
            try {
                // استدعاء المسار الجديد لحذف جلسة WhatsApp
                await apiFetch('/api/whatsapp/logout', { method: 'POST' });
                if (socket) socket.disconnect(); // قطع اتصال Socket.IO
            } catch (e) {
                console.warn("Failed to delete WhatsApp session on server, proceeding with local logout.", e);
            }
            
            // 2. تسجيل الخروج من التطبيق (Frontend)
            localStorage.removeItem('authToken'); 
            alert('تم تسجيل الخروج'); 
            window.location.href = 'index.html'; 
        });
    }
    
    // العناصر الرئيسية
    const mainContainer = document.querySelector('.container');
    const statusCard = document.getElementById('whatsapp-status-card');

    // الإخفاء الأولي لكل المحتوى
    if (mainContainer) mainContainer.style.display = 'none'; 
    if (statusCard) statusCard.style.display = 'none';

    // الخطوة الجديدة: التحقق من وجود العلامة "activated=true" في العنوان
    const urlParams = new URLSearchParams(window.location.search);
    const recentlyActivated = urlParams.get('activated') === 'true';

    try {
        let subscriptionActive = false;

        if (recentlyActivated) {
            console.log("Subscription recently activated. Bypassing server check and initializing WhatsApp...");
            subscriptionActive = true;
            // إزالة الـ parameter من URL لتنظيفه بعد الاستخدام
            window.history.replaceState(null, null, window.location.pathname);
            
        } else {
            console.log("Checking subscription status with cache bust...");
            const status = await apiFetch(`/api/check-status?_=${new Date().getTime()}`);
            subscriptionActive = status.active;
        }

        if (subscriptionActive) {
            console.log("Subscription is active. Initializing WhatsApp...");
            // في حالة النجاح: إظهار الـ Container و الـ WhatsApp Status Card ونبدأ الاتصال
            if (mainContainer) mainContainer.style.display = 'block'; 
            if (statusCard) statusCard.style.display = 'block'; 
            initializeWhatsAppConnection();
        } else {
            console.log("Subscription is inactive. Redirecting to activation page...");
            // إذا لم يكن فعالاً: التحويل مباشرة لصفحة التفعيل
            window.location.href = 'activate.html';
        }
    } catch (error) {
        console.error("Failed to check status:", error.message);
        // في حالة فشل التحقق من التوكن (401)
        if (error.message !== 'Subscription has expired' && error.message !== 'Authentication failed') {
            localStorage.removeItem('authToken'); 
            window.location.href = 'index.html';
        }
    }
});

function initializeWhatsAppConnection() {
    socket = io(); 
    
    const statusMessage = document.getElementById('status-message');
    const qrcodeCanvas = document.getElementById('qrcode-canvas');
    const statusCard = document.getElementById('whatsapp-status-card');
    const mainContent = document.getElementById('main-content'); 

    socket.on('connect', () => {
        statusMessage.textContent = 'جاري طلب الاتصال بواتساب...';
        const authToken = localStorage.getItem('authToken');
        if (authToken) socket.emit('init-whatsapp', authToken);
    });
    
    socket.on('qr', (qr) => {
        statusMessage.textContent = 'يرجى مسح هذا الـ QR Code:';
        qrcodeCanvas.style.display = 'block';
        QRCode.toCanvas(qrcodeCanvas, qr, { width: 256 }, (err) => { if(err) console.error(err); });
    });

    socket.on('status', (status) => {
        statusMessage.textContent = status.message;
        if (status.ready) {
            qrcodeCanvas.style.display = 'none';
            statusCard.style.backgroundColor = '#d4edda';
            log('✅ تم الاتصال بواتساب بنجاح!', 'green');
            setTimeout(() => {
                // إخفاء حالة الاتصال وإظهار الـ Dashboard الرئيسي
                if (statusCard) statusCard.style.display = 'none';
                if (mainContent) mainContent.style.display = 'block';
                loadInitialData();
            }, 2000);
        } else if (status.error) {
            statusCard.style.backgroundColor = '#f8d7da';
        }
    });

    socket.on('send-promo-status', (status) => {
        if (status.success) log(`✅ تم إرسال العرض بنجاح إلى +${status.phone}`, "green");
        else log(`❌ فشل الإرسال إلى +${status.phone}: ${status.error}`, "red");
    });
}

// ================================================================= //
// =================== 4. دالة مركزية للتواصل مع الـ API ============== //
// ================================================================= //
async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('authToken');
    const headers = { ...options.headers };
    if (token) { headers['Authorization'] = `Bearer ${token}`; }
    if (!(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; }

    const response = await fetch(url, { ...options, headers });

    // 403 هو خطأ انتهاء الاشتراك
    if (response.status === 403) { 
        // التعديل هنا: تحويل المستخدم لصفحة التفعيل بدلا من إظهار Overlay
        window.location.href = 'activate.html'; 
        throw new Error('Subscription has expired'); 
    } 
    // 401 هو خطأ التوكن
    if (response.status === 401) { localStorage.removeItem('authToken'); alert("انتهت صلاحية الجلسة"); window.location.href = 'index.html'; throw new Error('Authentication failed'); }
    if (!response.ok) { const errorData = await response.json().catch(() => ({ message: `HTTP Error: ${response.statusText}` })); throw new Error(errorData.message || 'حدث خطأ غير معروف'); }
    
    const contentType = response.headers.get("content-type");
    return contentType && contentType.includes("application/json") ? response.json() : response.text();
}

// ================================================================= //
// ====================== 5. وظائف تحميل البيانات =================== //
// ================================================================= //
function loadInitialData() {
    loadClients();
    loadImportedClients();
    loadPromos();
}

function loadClients() {
    apiFetch("/contacts")
        .then(data => { 
            // حل مشكل list.forEach is not a function
            clients = Array.isArray(data) ? data : []; 
            displayClients("clientsList", clients); 
        })
        .catch(err => { if (err.message !== 'Subscription has expired') log(`❌ خطأ تحميل العملاء: ${err.message}`, "red")});
}

function loadImportedClients() {
    apiFetch("/imported-contacts")
        .then(data => { 
            // حل مشكل list.forEach is not a function
            importedClients = Array.isArray(data) ? data : []; 
            displayClients("importedClientsList", importedClients); 
        })
        .catch(err => { if (err.message !== 'Subscription has expired') log(`❌ خطأ تحميل المستوردين: ${err.message}`, "red")});
}

function loadPromos() {
    apiFetch("/promos")
        .then(data => { 
            // حل مشكل list.forEach is not a function
            promos = Array.isArray(data) ? data : []; 
            displayPromos();
        })
        .catch(err => { if (err.message !== 'Subscription has expired') log("❌ خطأ تحميل العروض", "red")});
}

// ================================================================= //
// ======================== 6. وظائف العرض والتفاعل ======================== //
// ================================================================= //
function displayClients(containerId, list) {
    const cn = document.getElementById(containerId);
    cn.innerHTML = "";
    if (!list.length) { cn.textContent = "لا يوجد عملاء حالياً."; return; }
    list.forEach(c => {
        const div = document.createElement("div");
        div.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid #ddd;";
        div.innerHTML = `<span>${c.name || "بدون اسم"} - +${c.phone}</span> <button class="btn-danger" style="border:none;padding:5px 10px;border-radius:5px;cursor:pointer;" onclick="deleteClient('${containerId}', ${c.id})">حذف</button>`;
        cn.appendChild(div);
    });
}
function displayPromos() {
    const cn = document.getElementById("promosList");
    cn.innerHTML = "";
    // تم حذف التحقق من Array.isArray هنا لأنه تم في loadPromos
    if (!promos.length) { cn.textContent = "لا يوجد عروض حالياً."; return; }
    promos.forEach(p => {
        const div = document.createElement("div");
        div.className = "promo";
        div.id = `promo-${p.id}`;
        div.innerHTML = `<img src="promos/${p.image}" alt="صورة العرض"/><p title="${p.text}">${p.text.substr(0, 50)}...</p><div class="promo-buttons"><button type="button" class="btn-select" onclick="selectPromo(${p.id})"><i class="fas fa-check"></i> اختيار</button><button type="button" class="btn-delete" onclick="deletePromo(${p.id})"><i class="fas fa-trash"></i> حذف</button></div>`;
        cn.appendChild(div);
    });
}
function selectPromo(id) {
    selectedPromoId = id;
    log(`🔵 تم اختيار العرض #${id}`, "blue");
    document.querySelectorAll('.promo').forEach(p => p.classList.remove('selected'));
    document.getElementById(`promo-${id}`).classList.add('selected');
}
function deleteClient(containerId, id) {
    if (!confirm("هل أنت متأكد؟")) return;
    const table = containerId === "clientsList" ? "clients" : "imported_clients";
    apiFetch(`/delete/${table}/${id}`, { method: "DELETE" })
        .then(() => { log(`✅ تم حذف العميل`, "green"); if (table === "clients") loadClients(); else loadImportedClients(); })
        .catch(err => alert(`❌ خطأ أثناء الحذف: ${err.message}`));
}
function deleteAllImportedClients() {
    if (!confirm("هل أنت متأكد من حذف جميع العملاء المستوردين؟")) return;
    apiFetch("/deleteAll/imported_clients", { method: "DELETE" })
        .then(() => { log("✅ تم حذف جميع العملاء المستوردين", "green"); loadImportedClients(); })
        .catch(err => alert(`❌ خطأ أثناء الحذف: ${err.message}`));
}
function importCSV() {
    const inp = document.getElementById("csvFileInput");
    if (!inp.files.length) return alert("اختر ملف CSV");
    const fd = new FormData();
    fd.append("csv", inp.files[0]);
    apiFetch("/import-csv", { method: "POST", body: fd })
        .then(data => { alert(`✅ تم استيراد ${data.imported} عميل`); loadImportedClients(); })
        .catch(err => alert(`❌ خطأ أثناء الاستيراد: ${err.message}`));
}
function addNewPromo() {
    const text = document.getElementById("newPromoText").value.trim();
    const imgIn = document.getElementById("newPromoImage");
    if (!text || !imgIn.files.length) return alert("أدخل نص وصورة العرض");
    const fd = new FormData();
    fd.append("text", text);
    fd.append("image", imgIn.files[0]);
    apiFetch("/addPromo", { method: "POST", body: fd })
        .then(() => { alert("✅ تم إضافة العرض"); document.getElementById("newPromoText").value = ""; imgIn.value = ""; loadPromos(); })
        .catch(err => alert(`❌ خطأ أثناء الإضافة: ${err.message}`));
}
function deletePromo(id) {
    if (!confirm("متأكد من حذف العرض؟")) return;
    apiFetch(`/deletePromo/${id}`, { method: "DELETE" })
        .then(() => { log(`✅ تم حذف العرض #${id}`, "green"); loadPromos(); })
        .catch(err => alert(`❌ خطأ أثناء الحذف: ${err.message}`));
}

// ================================================================= //
// ========================= 7. وظائف الإرسال ======================= //
// ================================================================= //
function clientReady() {
    const mainContent = document.getElementById('main-content'); 
    if (mainContent.style.display !== 'block') { alert('❌ يرجى الانتظار حتى يتم الاتصال بواتساب بنجاح!'); return false; }
    return true;
}
function sendPromo(phone, promoId, fromImported = false) {
    if (!clientReady()) return;
    if (!socket) { log('❌ خطأ: اتصال Socket غير جاهز.', 'red'); return; } 
    const cleanPhone = phone.replace(/\D/g, "");
    log(`⏳ جاري إرسال العرض #${promoId} إلى +${cleanPhone}...`, 'orange');
    socket.emit('send-promo', { phone: cleanPhone, promoId, fromImported });
}
function sendSelectedPromo() {
    const phone = document.getElementById("phoneInput").value.trim();
    if (!phone) return alert("أدخل رقم الهاتف");
    if (!selectedPromoId) return alert("اختر عرض");
    sendPromo(phone, selectedPromoId, false); 
}
function testMessage() {
    if (!selectedPromoId) return alert("اختر عرض");
    sendPromo(adminNumber, selectedPromoId, false);
}
async function sendPromoSequentially(list, fromImported) {
    if (!clientReady() || !selectedPromoId) return alert("اختر عرض وانتظر اتصال واتساب");
    if (!list.length) return alert(`لا يوجد عملاء`);
    log(`🚀 بدء الإرسال المتسلسل لـ ${list.length} عميل...`, 'blue');
    for (let i = 0; i < list.length; i++) {
        sendPromo(list[i].phone, selectedPromoId, fromImported);
        if (i < list.length - 1) {
            const delay = 30000 + Math.random() * 30000;
            log(`⏳ انتظر ${Math.round(delay/1000)} ثواني...`, "orange");
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    log(`🏁 انتهى الإرسال المتسلسل`, "green");
}
function sendPromoToClients() {
    if (!clientReady() || !selectedPromoId) return alert("اختر عرض وانتظر اتصال واتساب");
    if (!clients.length) return alert("لا يوجد عملاء");
    clients.forEach(c => sendPromo(c.phone, selectedPromoId, false));
}
function sendPromoToImported() {
    if (!clientReady() || !selectedPromoId) return alert("اختر عرض وانتظر اتصال واتساب");
    if (!importedClients.length) return alert("لا يوجد عملاء");
    importedClients.forEach(c => sendPromo(c.phone, selectedPromoId, true));
}

// ================================================================= //
// ========================== 8. سجل ودعم (معدل) ========================== //
// ================================================================= //
function log(msg, color = "black") {
    const logsContainer = document.getElementById("logs");
    const entry = document.createElement("div");
    entry.style.color = color;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logsContainer.prepend(entry);
}