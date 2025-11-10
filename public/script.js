// ================================================================= //
// ==================== 1. التحقق من الأمان أولاً =================== //
// ================================================================= //
const token = localStorage.getItem('authToken');
if (!token) {
    window.location.href = 'login.html';
}

// ================================================================= //
// ========================= 2. متغيرات عامة ======================= //
// ================================================================= //
let clients = [];
let importedClients = [];
let promos = [];
let selectedPromoId = null;
const adminNumber = "212619145177";

// ================================================================= //
// ================== 3. إعداد الاتصال بـ Socket.io ================== //
// ================================================================= //
const socket = io();
const statusMessage = document.getElementById('status-message');
const qrcodeCanvas = document.getElementById('qrcode-canvas');
const statusCard = document.getElementById('whatsapp-status-card');
const mainContent = document.getElementById('main-content');

socket.on('connect', () => {
    console.log('Connected to server!');
    statusMessage.textContent = 'جاري طلب الاتصال بواتساب...';
    socket.emit('init-whatsapp');
});

socket.on('qr', (qr) => {
    statusMessage.textContent = 'يرجى مسح هذا الـ QR Code:';
    qrcodeCanvas.style.display = 'block';
    QRCode.toCanvas(qrcodeCanvas, qr, { width: 256 }, (err) => { if(err) console.error(err) });
});

socket.on('status', (status) => {
    statusMessage.textContent = status.message;
    if (status.ready) {
        qrcodeCanvas.style.display = 'none';
        statusCard.style.backgroundColor = '#d4edda';
        log('✅ تم الاتصال بواتساب بنجاح!', 'green');
        setTimeout(() => {
            statusCard.style.display = 'none';
            mainContent.style.display = 'block';
            loadClients();
            loadImportedClients();
            loadPromos();
        }, 2000);
    } else if (status.error) {
        statusCard.style.backgroundColor = '#f8d7da';
    }
});

socket.on('send-promo-status', (status) => {
    if (status.success) {
        log(`✅ تم إرسال العرض بنجاح إلى +${status.phone}`, "green");
    } else {
        log(`❌ فشل الإرسال إلى +${status.phone}: ${status.error}`, "red");
    }
});

// ================================================================= //
// =================== 4. دالة مركزية للتواصل مع الـ API ============== //
// ================================================================= //
async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('authToken');
    const headers = { ...options.headers };
    if (token) { headers['Authorization'] = `Bearer ${token}`; }
    if (!(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; }

    const response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
        localStorage.removeItem('authToken');
        alert("انتهت صلاحية الجلسة، يرجى تسجيل الدخول مرة أخرى.");
        window.location.href = 'login.html';
        throw new Error('Authentication failed');
    }
    
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: `HTTP Error: ${response.statusText}` }));
        throw new Error(errorData.message || 'حدث خطأ غير معروف');
    }

    const contentType = response.headers.get("content-type");
    return contentType && contentType.includes("application/json") ? response.json() : response.text();
}

// ================================================================= //
// ======================= 5. عند تحميل الصفحة ===================== //
// ================================================================= //
document.addEventListener('DOMContentLoaded', () => {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            localStorage.removeItem('authToken');
            alert('تم تسجيل الخروج');
            window.location.href = 'login.html';
        });
    }
});

// ================================================================= //
// ====================== 6. وظائف العملاء ========================= //
// ================================================================= //
function loadClients() {
    apiFetch("/contacts")
        .then(data => { clients = data || []; displayClients("clientsList", clients); })
        .catch(err => log(`❌ خطأ تحميل العملاء: ${err.message}`, "red"));
}

function loadImportedClients() {
    apiFetch("/imported-contacts")
        .then(data => { importedClients = data || []; displayClients("importedClientsList", importedClients); })
        .catch(err => log(`❌ خطأ تحميل العملاء المستوردين: ${err.message}`, "red"));
}

function displayClients(containerId, list) {
    const cn = document.getElementById(containerId);
    cn.innerHTML = "";
    if (!list.length) {
        cn.textContent = "لا يوجد عملاء حالياً.";
        return;
    }
    list.forEach(c => {
        const div = document.createElement("div");
        div.style.display = "flex";
        div.style.justifyContent = "space-between";
        div.style.alignItems = "center";
        div.style.padding = "5px 0";
        div.style.borderBottom = "1px solid #ddd";
        div.innerHTML = `<span>${c.name || "بدون اسم"} - +${c.phone}</span> <button class="btn-danger" style="border:none;padding:5px 10px;border-radius:5px;cursor:pointer;" onclick="deleteClient('${containerId}', ${c.id})">حذف</button>`;
        cn.appendChild(div);
    });
}

function deleteClient(containerId, id) {
    if (!confirm("هل أنت متأكد؟")) return;
    const table = containerId === "clientsList" ? "clients" : "imported_clients";
    apiFetch(`/delete/${table}/${id}`, { method: "DELETE" })
        .then(() => {
            log(`✅ تم حذف العميل`, "green");
            if (table === "clients") loadClients(); else loadImportedClients();
        })
        .catch(err => alert(`❌ خطأ أثناء الحذف: ${err.message}`));
}

function deleteAllImportedClients() {
    if (!confirm("هل أنت متأكد من حذف جميع العملاء المستوردين؟")) return;
    apiFetch("/deleteAll/imported_clients", { method: "DELETE" })
        .then(() => {
            log("✅ تم حذف جميع العملاء المستوردين", "green");
            loadImportedClients();
        })
        .catch(err => alert(`❌ خطأ أثناء الحذف: ${err.message}`));
}

function importCSV() {
    const inp = document.getElementById("csvFileInput");
    if (!inp.files.length) return alert("اختر ملف CSV");
    const fd = new FormData();
    fd.append("csv", inp.files[0]);

    apiFetch("/import-csv", { method: "POST", body: fd })
        .then(data => {
            alert(`✅ تم استيراد ${data.imported} عميل`);
            loadImportedClients();
        })
        .catch(err => alert(`❌ خطأ أثناء الاستيراد: ${err.message}`));
}

// ================================================================= //
// ======================== 7. وظائف العروض (معدلة) ======================== //
// ================================================================= //
function loadPromos() {
    apiFetch("/promos")
        .then(data => { promos = data || []; displayPromos(); })
        .catch(err => log("❌ خطأ تحميل العروض", "red"));
}

function displayPromos() {
    const cn = document.getElementById("promosList");
    cn.innerHTML = "";
    promos.forEach(p => {
        const preview = p.text.length > 50 ? p.text.substr(0, 50) + "..." : p.text;
        const div = document.createElement("div");
        div.className = "promo"; // تطبيق الـ class من CSS
        div.id = `promo-${p.id}`;
        
        div.innerHTML = `
          <img src="promos/${p.image}" alt="صورة العرض"/>
          <p title="${p.text}">${preview}</p>
          <div class="promo-buttons">
              <button type="button" class="btn-select" onclick="selectPromo(${p.id})">
                  <i class="fas fa-check"></i> اختيار
              </button>
              <button type="button" class="btn-delete" onclick="deletePromo(${p.id})">
                  <i class="fas fa-trash"></i> حذف
              </button>
          </div>
        `;
        cn.appendChild(div);
    });
}

function selectPromo(id) {
    selectedPromoId = id;
    log(`🔵 تم اختيار العرض #${id}`, "blue");
    document.querySelectorAll('.promo').forEach(p => p.classList.remove('selected'));
    document.getElementById(`promo-${id}`).classList.add('selected');
}

function addNewPromo() {
    const text = document.getElementById("newPromoText").value.trim();
    const imgIn = document.getElementById("newPromoImage");
    if (!text || !imgIn.files.length) return alert("أدخل نص وصورة العرض");

    const fd = new FormData();
    fd.append("text", text);
    fd.append("image", imgIn.files[0]);

    apiFetch("/addPromo", { method: "POST", body: fd })
        .then(() => {
            alert("✅ تم إضافة العرض");
            document.getElementById("newPromoText").value = "";
            imgIn.value = "";
            loadPromos();
        })
        .catch(err => alert(`❌ خطأ أثناء الإضافة: ${err.message}`));
}

function deletePromo(id) {
    if (!confirm("متأكد من حذف العرض؟")) return;
    apiFetch(`/deletePromo/${id}`, { method: "DELETE" })
        .then(() => {
            log(`✅ تم حذف العرض #${id}`, "green");
            loadPromos();
        })
        .catch(err => alert(`❌ خطأ أثناء الحذف: ${err.message}`));
}

// ================================================================= //
// ========================= 8. وظائف الإرسال ======================= //
// ================================================================= //
function clientReady() {
    if (mainContent.style.display !== 'block') {
        alert('❌ يرجى الانتظار حتى يتم الاتصال بواتساب بنجاح!');
        return false;
    }
    return true;
}

function sendPromo(phone, promoId, fromImported = false) {
    if (!clientReady()) return;
    const cleanPhone = phone.replace(/\D/g, "");
    log(`⏳ جاري إرسال العرض #${promoId} إلى +${cleanPhone}...`, 'orange');
    socket.emit('send-promo', { phone: cleanPhone, promoId, fromImported });
}

function sendSelectedPromo() {
    const phone = document.getElementById("phoneInput").value.trim();
    if (!phone) return alert("أدخل رقم الهاتف");
    if (!selectedPromoId) return alert("اختر عرض");
    sendPromo(phone, selectedPromoId, document.getElementById("clientTypeSelect").value === "imported_clients");
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
        if (i < list.length - 1) { // لا تنتظر بعد آخر رسالة
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
// ========================== 9. سجل الأحداث ======================== //
// ================================================================= //
function log(msg, color = "black") {
    const logsContainer = document.getElementById("logs");
    const entry = document.createElement("div");
    entry.style.color = color;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logsContainer.prepend(entry);
}