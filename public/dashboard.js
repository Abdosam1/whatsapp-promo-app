// ================================================================= //
// ============ 0. AUTHENTICATION & TOKEN HANDLING ================= //
// ================================================================= //

// 1. استخراج التوكن من الرابط (عند الدخول عبر Google)
const urlParams = new URLSearchParams(window.location.search);
const tokenFromUrl = urlParams.get('token');

if (tokenFromUrl) {
    // حفظ التوكن في الذاكرة
    localStorage.setItem('authToken', tokenFromUrl);
    // تنظيف الرابط من التوكن ليبقى نظيفاً
    window.history.replaceState({}, document.title, "/dashboard.html");
}

// 2. التحقق من وجود التوكن (الحماية)
const token = localStorage.getItem('authToken');
if (!token) {
    // إذا لم يوجد توكن، ارجع لصفحة الدخول
    window.location.replace('index.html');
}

// ================================================================= //
// ======================== 1. GLOBAL VARIABLES ==================== //
// ================================================================= //

// بيانات التطبيق
let clients = [];
let importedClients = [];
let promos = [];

// حالة التطبيق
let selectedPromoId = null;
let socket = null;
let isWhatsappReady = false; // هل الواتساب متصل؟
let isCampaignRunning = false;

// إحصائيات
let globalSuccessCount = 0;
let globalFailCount = 0;

// متغيرات الفلتر
let validNumbersBuffer = [];

// ================================================================= //
// ======================== 2. UI ELEMENTS ========================= //
// ================================================================= //

const uiElements = {
    // Header & Nav
    logoutBtn: document.getElementById('logoutBtn'),
    statusCard: document.getElementById('whatsapp-status-card'),
    statusMessage: document.getElementById('status-message-display') || document.getElementById('status-message'),
    qrcodeCanvas: document.getElementById('qrcode-canvas'),
    disconnectWhatsappBtn: document.getElementById('disconnectWhatsappBtn'),
    
    // Containers
    mainContent: document.getElementById('main-content'),
    clientsList: document.getElementById('clientsList'),
    importedClientsList: document.getElementById('importedClientsList'),
    promosList: document.getElementById('promosList'),
    logsContainer: document.getElementById('logs'),
    
    // Import & CSV
    csvFileInput: document.getElementById('csvFileInput'),
    importCsvBtn: document.getElementById('importCsvBtn'),
    
    // Campaign Buttons
    sendSequentiallyClientsBtn: document.getElementById('sendSequentiallyClientsBtn'),
    sendSequentiallyImportedBtn: document.getElementById('sendSequentiallyImportedBtn'),
    deleteAllImportedBtn: document.getElementById('deleteAllImportedBtn'),
    exportClientsBtn: document.getElementById('exportClientsBtn'),
    
    // Promo Creation
    newPromoText: document.getElementById('newPromoText'),
    newPromoImage: document.getElementById('newPromoImage'),
    addNewPromoBtn: document.getElementById('addNewPromoBtn'),
    generateSpintaxBtn: document.getElementById('generateSpintaxBtn'),
    
    // Single Send
    phoneInput: document.getElementById('phoneInput'),
    sendSelectedPromoBtn: document.getElementById('sendSelectedPromoBtn'),
    
    // Chatbot
    chatbotPrompt: document.getElementById('chatbotPrompt'),
    savePromptBtn: document.getElementById('savePromptBtn'),
    syncContactsBtn: document.getElementById('syncContactsBtn'),
    chatbotStatusToggle: document.getElementById('chatbotStatusToggle'),
    
    // Stats
    statSuccess: document.getElementById('stat-sent-success'),
    statFailed: document.getElementById('stat-sent-failed'),
    statTotal: document.getElementById('stat-total-contacts'),
    
    // === FILTER ELEMENTS (عناصر الفلتر) ===
    filterInput: document.getElementById('filterInput'),
    startFilterBtn: document.getElementById('startFilterBtn'),
    stopFilterBtn: document.getElementById('stopFilterBtn'), // زر التوقف
    exportValidBtn: document.getElementById('exportValidBtn'),
    listValid: document.getElementById('listValid'),
    listInvalid: document.getElementById('listInvalid'),
    countValid: document.getElementById('countValid'),
    countInvalid: document.getElementById('countInvalid'),
    filterStatus: document.getElementById('filterStatus'),
    
    // Filter Upload Elements
    filterFileInput: document.getElementById('filterFileInput'),
    btnUploadFilter: document.getElementById('btnUploadFilter')
};

// ================================================================= //
// ==================== 3. INITIALIZATION (البدء) ================== //
// ================================================================= //

document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();      // تشغيل الأزرار
    initializeWhatsAppConnection();  // الاتصال بالسيرفر
    loadInitialData();               // تحميل البيانات
    setupLogsObserver();             // مراقبة العداد
});

function initializeEventListeners() {
    // 1. التنقل بين التبويبات (Tabs)
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tabName = item.getAttribute('data-tab');
            if (tabName) {
                switchTab(tabName);
            }
        });
    });

    // 2. تسجيل الخروج
    if (uiElements.logoutBtn) {
        uiElements.logoutBtn.addEventListener('click', () => handleLogout(false));
    }

    // 3. إضافة عرض جديد
    if (uiElements.addNewPromoBtn) {
        uiElements.addNewPromoBtn.addEventListener('click', addNewPromo);
    }

    // 4. استيراد CSV (Import)
    if (uiElements.importCsvBtn) {
        uiElements.importCsvBtn.addEventListener('click', importCSV);
    }
    
    // 5. أزرار الإرسال الجماعي
    if (uiElements.sendSequentiallyClientsBtn) {
        uiElements.sendSequentiallyClientsBtn.addEventListener('click', () => {
            startNewCampaign();
            sendPromoSequentially(clients, false);
        });
    }
    if (uiElements.sendSequentiallyImportedBtn) {
        uiElements.sendSequentiallyImportedBtn.addEventListener('click', () => {
            startNewCampaign();
            sendPromoSequentially(importedClients, true);
        });
    }

    // 6. أزرار الإدارة (حذف وتصدير)
    if (uiElements.deleteAllImportedBtn) uiElements.deleteAllImportedBtn.addEventListener('click', deleteAllImported);
    if (uiElements.exportClientsBtn) uiElements.exportClientsBtn.addEventListener('click', exportClientsToCSV);

    // 7. الشات بوت والإرسال الفردي
    if (uiElements.sendSelectedPromoBtn) uiElements.sendSelectedPromoBtn.addEventListener('click', sendSelectedPromo);
    if (uiElements.savePromptBtn) uiElements.savePromptBtn.addEventListener('click', saveChatbotPrompt);
    if (uiElements.syncContactsBtn) uiElements.syncContactsBtn.addEventListener('click', requestContactSync);
    if (uiElements.chatbotStatusToggle) uiElements.chatbotStatusToggle.addEventListener('change', toggleChatbotStatus);
    if (uiElements.generateSpintaxBtn) uiElements.generateSpintaxBtn.addEventListener('click', generateSpintax);

    // 8. زر فصل الواتساب
    if (uiElements.disconnectWhatsappBtn) {
        uiElements.disconnectWhatsappBtn.addEventListener('click', () => {
            if(confirm("هل أنت متأكد أنك تريد فصل الرقم وحذف الجلسة؟")) {
                if(socket) {
                    socket.emit('logout-whatsapp'); 
                    uiElements.statusMessage.innerText = "جاري الفصل...";
                    uiElements.disconnectWhatsappBtn.style.display = 'none';
                }
            }
        });
    }

    // === 9. أزرار الفلتر (FILTER LOGIC) ===
    
    // زر البدء
    if (uiElements.startFilterBtn) {
        uiElements.startFilterBtn.addEventListener('click', startNumberFilter);
    }
    
    // زر التوقف (Stop)
    if (uiElements.stopFilterBtn) {
        uiElements.stopFilterBtn.addEventListener('click', stopNumberFilter);
    }
    
    // زر التصدير (Export)
    if (uiElements.exportValidBtn) {
        uiElements.exportValidBtn.addEventListener('click', exportValidNumbers);
    }
    
    // زر رفع ملف الفلتر (Upload List)
    if (uiElements.btnUploadFilter && uiElements.filterFileInput) {
        uiElements.btnUploadFilter.addEventListener('click', () => {
            uiElements.filterFileInput.click(); // محاكاة النقر على Input المخفي
        });

        uiElements.filterFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = function(event) {
                const content = event.target.result;
                // استخراج الأرقام وتنظيفها
                const numbers = content.split(/\r?\n/)
                                    .map(line => line.trim().replace(/[^0-9]/g, ''))
                                    .filter(n => n.length > 5) // تجاهل الأرقام القصيرة جداً
                                    .join('\n');
                
                uiElements.filterInput.value = numbers;
                uiElements.filterFileInput.value = ''; // إعادة تعيين الملف
                alert(`تم تحميل ${numbers.split('\n').length} رقم جاهز للفحص.`);
            };
            reader.readAsText(file);
        });
    }
}

function switchTab(tabName) {
    // إزالة Active من جميع الأزرار
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    // تفعيل الزر المختار
    const selectedNav = document.querySelector(`.nav-item[data-tab="${tabName}"]`);
    if (selectedNav) selectedNav.classList.add('active');

    // إخفاء جميع الأقسام
    document.querySelectorAll('.tab-section').forEach(el => el.classList.remove('active-section'));
    // إظهار القسم المختار
    const selectedTab = document.getElementById('tab-' + tabName);
    if(selectedTab) selectedTab.classList.add('active-section');
}

// ================================================================= //
// =============== 4. SOCKET.IO LOGIC (الاتصال بالسيرفر) =========== //
// ================================================================= //

function initializeWhatsAppConnection() {
    // الاتصال بالسيرفر مع إرسال التوكن
    socket = io({ auth: { token } });
    
    // عند نجاح الاتصال بالسيرفر
    socket.on('connect', () => { 
        log('🔌 تم الاتصال بالسيرفر بنجاح.', 'blue'); 
        socket.emit('init-whatsapp', token); 
    });

    // عند طلب مسح QR Code
    socket.on('qr', (qr) => {
        isWhatsappReady = false;
        uiElements.statusMessage.textContent = 'يرجى مسح QR Code أدناه:';
        uiElements.statusMessage.style.color = 'orange';
        uiElements.qrcodeCanvas.style.display = 'block';
        
        if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'none';
        
        // رسم الـ QR Code
        QRCode.toCanvas(uiElements.qrcodeCanvas, qr, { width: 256 }, (err) => {
            if (err) console.error(err);
        });
    });

    // تحديث حالة الاتصال
    socket.on('status', (status) => {
        uiElements.statusMessage.textContent = status.message;
        
        if (status.ready) {
            // متصل
            isWhatsappReady = true;
            uiElements.statusMessage.style.color = '#00d26a'; // أخضر
            uiElements.qrcodeCanvas.style.display = 'none';
            
            if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'inline-block';
            
            // تحديث البيانات
            loadInitialData();
            log('✅ تم الاتصال بواتساب بنجاح!', 'green');
        } else {
            // غير متصل
            isWhatsappReady = false;
            uiElements.statusMessage.style.color = 'orange';
            if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'none';
        }
    });

    // عند تسجيل الخروج
    socket.on('whatsapp-logged-out', () => {
        log('ℹ️ تم تسجيل الخروج ومسح الجلسة.', 'orange');
        clients = []; 
        importedClients = [];
        
        // تصفير القوائم
        if(uiElements.clientsList) uiElements.clientsList.innerHTML = '<p class="empty-list">القائمة فارغة.</p>';
        if(uiElements.importedClientsList) uiElements.importedClientsList.innerHTML = '<p class="empty-list">القائمة فارغة.</p>';
        if(uiElements.statTotal) uiElements.statTotal.innerText = '0';
        
        // طلب تهيئة جديدة (لإظهار QR جديد)
        isWhatsappReady = false;
        socket.emit('init-whatsapp', token);
        
        uiElements.qrcodeCanvas.style.display = 'block';
        if(uiElements.disconnectWhatsappBtn) uiElements.disconnectWhatsappBtn.style.display = 'none';
    });

    // حالة إرسال الرسائل
    socket.on('send-promo-status', (status) => {
        if (status.success) {
            log(`✅ تم الإرسال إلى +${status.phone}`, "green");
        } else {
            log(`❌ فشل الإرسال إلى +${status.phone}: ${status.error}`, "red");
        }
    });

    // === أحداث الفلتر (Filter Events) ===
    socket.on('filter-result', (data) => {
        // إنشاء عنصر للعرض
        const div = document.createElement('div');
        div.innerText = data.phone;
        div.style.padding = "2px 5px";
        div.style.borderBottom = "1px solid rgba(255,255,255,0.05)";

        if (data.status === 'valid') {
            // رقم صحيح
            div.style.color = "#4ade80"; // أخضر
            uiElements.listValid.appendChild(div);
            
            // إضافة للمصفوفة
            validNumbersBuffer.push(data.phone);
            uiElements.countValid.innerText = validNumbersBuffer.length;
            
            // تفعيل زر التحميل فوراً
            if (uiElements.exportValidBtn.disabled) {
                uiElements.exportValidBtn.disabled = false;
                uiElements.exportValidBtn.classList.remove('btn-secondary');
                uiElements.exportValidBtn.classList.add('btn-success');
            }
        } else {
            // رقم غير صحيح
            div.style.color = "#f87171"; // أحمر
            uiElements.listInvalid.appendChild(div);
            
            const currentInvalid = parseInt(uiElements.countInvalid.innerText) || 0;
            uiElements.countInvalid.innerText = currentInvalid + 1;
        }
    });

    socket.on('filter-complete', (counts) => {
        resetFilterUI(false);
        uiElements.filterStatus.innerText = `✅ انتهى الفحص. (صالح: ${counts.valid})`;
        log('✅ انتهت عملية الفحص.', 'green');
    });

    socket.on('filter-stopped', () => {
        resetFilterUI(false);
        uiElements.filterStatus.innerText = "🛑 تم الإيقاف.";
        log('🛑 تم إيقاف الفحص يدوياً.', 'orange');
    });

    socket.on('filter-error', (msg) => {
        alert(msg);
        resetFilterUI(false);
        uiElements.filterStatus.innerText = "❌ حدث خطأ.";
    });

    // أحداث أخرى
    socket.on('disconnect', () => { 
        isWhatsappReady = false; 
        log('🔌 انقطع الاتصال بالسيرفر.', 'red'); 
    });
    
    socket.on('log', (data) => log(data.message, data.color));
    
    socket.on('sync-complete', () => { 
        log('✅ تمت المزامنة مع الهاتف.', 'green'); 
        loadClients(); // إعادة تحميل جهات الاتصال
        if(uiElements.syncContactsBtn) uiElements.syncContactsBtn.disabled = false; 
    });
}

// ================================================================= //
// ================= 5. FILTER FUNCTIONS (منطق الفلتر) ============= //
// ================================================================= //

function startNumberFilter() {
    const text = uiElements.filterInput.value.trim();
    if (!text) return alert("⚠️ المرجو إدخال أرقام للفحص.");
    
    // تهيئة الواجهة
    uiElements.listValid.innerHTML = '';
    uiElements.listInvalid.innerHTML = '';
    uiElements.countValid.innerText = '0';
    uiElements.countInvalid.innerText = '0';
    uiElements.filterStatus.innerText = "جاري الفحص... ⏳";
    
    validNumbersBuffer = [];

    // إخفاء زر البدء وإظهار زر التوقف
    uiElements.startFilterBtn.style.display = 'none';
    if(uiElements.stopFilterBtn) {
        uiElements.stopFilterBtn.style.display = 'inline-block';
        uiElements.stopFilterBtn.disabled = false;
        uiElements.stopFilterBtn.textContent = "توقف";
    }
    
    // تعطيل زر التحميل مؤقتاً
    uiElements.exportValidBtn.disabled = true;
    uiElements.exportValidBtn.classList.remove('btn-success');
    uiElements.exportValidBtn.classList.add('btn-secondary');

    // إرسال الطلب
    socket.emit('check-numbers', { numbers: text });
}

function stopNumberFilter() {
    if(confirm("هل تريد حقاً إيقاف الفحص؟")) {
        if(uiElements.stopFilterBtn) {
            uiElements.stopFilterBtn.textContent = "جاري التوقف...";
            uiElements.stopFilterBtn.disabled = true;
        }
        socket.emit('stop-filter');
    }
}

function resetFilterUI(isRunning) {
    // إعادة الأزرار لحالتها الطبيعية
    uiElements.startFilterBtn.style.display = 'inline-block';
    if(uiElements.stopFilterBtn) {
        uiElements.stopFilterBtn.style.display = 'none';
    }
    // زر التحميل يبقى مفعلاً إذا وجدنا نتائج
    if (validNumbersBuffer.length > 0) {
        uiElements.exportValidBtn.disabled = false;
    }
}

function exportValidNumbers() {
    if (validNumbersBuffer.length === 0) return alert("لا توجد أرقام صالحة.");

    const csvContent = "Phone\n" + validNumbersBuffer.join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.href = url;
    link.download = `valid_numbers_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if(confirm("تم التحميل! هل تريد مسح النتائج لبدء فحص جديد؟")) {
        uiElements.listValid.innerHTML = '';
        uiElements.listInvalid.innerHTML = '';
        uiElements.countValid.innerText = '0';
        uiElements.countInvalid.innerText = '0';
        uiElements.filterInput.value = '';
        uiElements.exportValidBtn.disabled = true;
        uiElements.exportValidBtn.classList.remove('btn-success');
        uiElements.exportValidBtn.classList.add('btn-secondary');
        uiElements.filterStatus.innerText = "...";
        validNumbersBuffer = [];
    }
}

// ================================================================= //
// ================= 6. IMPORT & API FUNCTIONS (الوظائف) =========== //
// ================================================================= //

// دالة استيراد CSV
async function importCSV() { 
    const fileInput = document.getElementById('csvFileInput');
    const file = fileInput.files[0]; 
    
    if (!file) return alert('⚠️ اختر ملف CSV أولاً.'); 
    
    const btn = document.getElementById('importCsvBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    btn.disabled = true;

    const formData = new FormData(); 
    formData.append('csv', file); 
    
    try { 
        const res = await apiFetch('/import-csv', { method: 'POST', body: formData }); 
        if (res && res.message) {
            log(`✅ تم استيراد ${res.imported} رقم.`, 'green'); 
            alert(`تم استيراد ${res.imported} عميل بنجاح.`);
            fileInput.value = ''; 
            loadImportedClients(); 
        } else {
            alert("حدث خطأ أثناء الرفع.");
        }
    } catch (err) {
        console.error(err);
        alert("❌ فشل الرفع: " + err.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// دوال API المساعدة
async function apiFetch(url, options = {}) {
    const headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
    if (!(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; }
    try {
        const response = await fetch(url, { ...options, headers });
        
        if (response.status === 401) { 
            handleLogout(true); 
            throw new Error('Session Expired'); 
        }
        if (response.status === 403) {
            window.location.replace('/activate.html');
            throw new Error('Subscription expired');
        }
        if (!response.ok) throw new Error(`Server Error: ${response.statusText}`);
        
        const text = await response.text();
        return text ? JSON.parse(text) : {};
    } catch (error) {
        if (error.message !== 'Subscription expired') log(`❌ Error: ${error.message}`, 'red');
        throw error;
    }
}

// تحميل البيانات
function loadInitialData() { 
    loadClients(); 
    loadImportedClients(); 
    loadPromos(); 
    loadChatbotPrompt(); 
    loadChatbotStatus();
}

async function loadClients() { try { clients = await apiFetch("/contacts") || []; displayClients(uiElements.clientsList, clients); } catch (err) {} }
async function loadImportedClients() { try { importedClients = await apiFetch("/imported-contacts") || []; displayClients(uiElements.importedClientsList, importedClients); } catch (err) {} }
async function loadPromos() { try { promos = await apiFetch("/promos") || []; displayPromos(); } catch (err) {} }

function displayClients(container, list) {
    container.innerHTML = "";
    if (!list || !list.length) { container.innerHTML = `<p class="empty-list">القائمة فارغة.</p>`; return; }
    list.forEach(client => {
        const div = document.createElement("div");
        div.className = 'client-item';
        div.innerHTML = `<span>${client.name || 'Unknown'} <strong>+${client.phone}</strong></span>`;
        container.appendChild(div);
    });
    // تحديث العداد الإجمالي
    if(uiElements.statTotal) {
        const total = (clients.length || 0) + (importedClients.length || 0);
        uiElements.statTotal.innerText = total;
    }
}

function displayPromos() {
    uiElements.promosList.innerHTML = "";
    if (!promos || !promos.length) { uiElements.promosList.innerHTML = `<p class="empty-list">لا توجد عروض.</p>`; return; }
    promos.forEach(promo => {
        const div = document.createElement("div");
        div.className = "promo";
        div.id = `promo-${promo.id}`;
        const imageHtml = promo.image ? `<img src="promos/${promo.image}" alt="Promo">` : '';
        div.innerHTML = `
            ${imageHtml}
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

// عمليات أخرى
async function addNewPromo() {
    const text = uiElements.newPromoText.value.trim();
    const imageFile = uiElements.newPromoImage.files[0];
    if (!text && !imageFile) return alert('أدخل نصاً أو صورة.');
    
    const btn = uiElements.addNewPromoBtn;
    btn.disabled = true;
    btn.innerHTML = 'جاري الحفظ...';

    const formData = new FormData();
    formData.append('text', text);
    if (imageFile) formData.append('image', imageFile);
    try {
        await apiFetch('/addPromo', { method: 'POST', body: formData });
        log("✅ تم إضافة العرض.", 'green');
        uiElements.newPromoText.value = '';
        uiElements.newPromoImage.value = '';
        loadPromos();
    } catch (err) { alert("خطأ في الحفظ"); }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> حفظ الحملة'; }
}

function selectPromo(id) { selectedPromoId = id; log(`🔵 تم اختيار العرض #${id}`, "blue"); document.querySelectorAll('.promo').forEach(p => p.classList.remove('selected')); document.getElementById(`promo-${id}`).classList.add('selected'); }
async function deletePromo(id) { if (!confirm("حذف العرض؟")) return; try { await apiFetch(`/deletePromo/${id}`, { method: "DELETE" }); loadPromos(); } catch (err) {} }
async function deleteAllImported() { if (!confirm("حذف جميع المستوردين؟")) return; try { await apiFetch('/api/delete-all-imported', { method: 'DELETE' }); loadImportedClients(); } catch(err) {} }
function exportClientsToCSV() {
    if (!clients || clients.length === 0) return alert("القائمة فارغة.");
    const csvContent = "phone,name\n" + clients.map(c => `${c.phone},${c.name || ''}`).join('\n');
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "contacts.csv";
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
}

async function loadChatbotPrompt() { try { const data = await apiFetch('/api/chatbot-prompt'); if (uiElements.chatbotPrompt && data.prompt) uiElements.chatbotPrompt.value = data.prompt; } catch (e) {} }
async function saveChatbotPrompt() { const prompt = uiElements.chatbotPrompt.value; try { await apiFetch('/api/chatbot-prompt', { method: 'POST', body: JSON.stringify({ prompt }) }); log(`✅ تم الحفظ.`, 'green'); } catch (e) {} }
function requestContactSync() { if (!isWhatsappReady) return alert('غير متصل.'); log('🔄 جاري التحديث...', 'blue'); if(uiElements.syncContactsBtn) uiElements.syncContactsBtn.disabled = true; socket.emit('sync-contacts'); }
async function loadChatbotStatus() { try { const data = await apiFetch('/api/chatbot-status'); if (uiElements.chatbotStatusToggle) uiElements.chatbotStatusToggle.checked = data.isActive; } catch (e) {} }
async function toggleChatbotStatus() { const isActive = uiElements.chatbotStatusToggle.checked; try { await apiFetch('/api/chatbot-status', { method: 'POST', body: JSON.stringify({ isActive }) }); log(`✅ تم التحديث.`, 'green'); } catch (e) {} }
async function generateSpintax() {
    const text = uiElements.newPromoText.value.trim(); if (!text) return alert("اكتب النص أولاً.");
    if(uiElements.generateSpintaxBtn) uiElements.generateSpintaxBtn.disabled = true;
    try { const res = await apiFetch('/api/generate-spintax', { method: 'POST', body: JSON.stringify({ text }) }); if (res.spintax) { uiElements.newPromoText.value = res.spintax; log('✅ تم الإنشاء.', 'green'); } } catch (e) {} finally { if(uiElements.generateSpintaxBtn) uiElements.generateSpintaxBtn.disabled = false; }
}

function sendPromo(phone, promoId, fromImported) { if (!isWhatsappReady) return; log(`⏳ جاري الإرسال إلى +${phone}...`, 'blue'); socket.emit('send-promo', { phone, promoId, fromImported }); }
function sendSelectedPromo() { const phone = uiElements.phoneInput.value.trim(); if (!phone) return alert("أدخل الرقم."); if (!selectedPromoId) return alert("اختر عرضاً."); sendPromo(phone, selectedPromoId, false); }

async function sendPromoSequentially(list, fromImported) {
    if (!selectedPromoId) return alert("اختر عرضاً.");
    if (!list || list.length === 0) return alert("القائمة فارغة.");
    if (!isWhatsappReady) return alert("انتظر الاتصال.");
    if (!confirm(`بدء الحملة لـ ${list.length} رقم؟`)) return;
    
    log('🤖 تفعيل الحملة...', 'blue');
    socket.emit('start-campaign-mode', { promoId: selectedPromoId });
    
    isCampaignRunning = true;
    
    // Loop
    for (let i = 0; i < list.length; i++) {
        if (!isWhatsappReady) { log('🛑 توقف (انقطع الاتصال).', 'red'); break; }
        sendPromo(list[i].phone, selectedPromoId, fromImported);
        
        // Random Delay (5-10 seconds)
        const delay = 5000 + Math.random() * 5000;
        await new Promise(r => setTimeout(r, delay));
    }
    isCampaignRunning = false;
    log('🎉 انتهت الحملة.', 'green');
}

async function handleLogout(isForced = false) {
    if (!isForced && !confirm("تسجيل الخروج؟")) return;
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    localStorage.removeItem('authToken');
    window.location.replace('index.html');
}

function log(message, color = "black") {
    const p = document.createElement("p");
    p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    p.style.color = color;
    uiElements.logsContainer.prepend(p);
}

function setupLogsObserver() {
    const logsContainer = uiElements.logsContainer;
    if(!logsContainer) return;
    const observer = new MutationObserver((mutations) => {
        if (!isCampaignRunning) return;
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1) { 
                     const text = node.innerText.toLowerCase();
                     if (text.includes('success') || text.includes('تم إرسال')) {
                         globalSuccessCount++;
                         if(uiElements.statSuccess) uiElements.statSuccess.innerText = globalSuccessCount;
                     }
                     if (text.includes('fail') || text.includes('error') || text.includes('فشل')) {
                         globalFailCount++;
                         if(uiElements.statFailed) uiElements.statFailed.innerText = globalFailCount;
                     }
                }
            });
        });
    });
    observer.observe(logsContainer, { childList: true });
}
