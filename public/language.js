document.addEventListener('DOMContentLoaded', () => {
    // هذا الكائن سيحتوي على جميع الترجمات
    const translations = {};

    /**
     *  1. تحميل ملف الترجمة (translate.json)
     */
    async function loadTranslations() {
        try {
            // تأكد أن اسم الملف يطابق الملف الموجود لديك
            const response = await fetch('translate.json');
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            
            // دمج الترجمات
            Object.assign(translations, data);
            
            // تشغيل الموقع بعد تحميل البيانات
            initialize();
        } catch (error) {
            console.error("Could not load translate.json:", error);
        }
    }

    /**
     *  2. تطبيق اللغة
     */
    function setLanguage(lang) {
        if (!translations[lang]) return;

        // أ. تحديث النصوص (data-i18n)
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            if (translations[lang][key]) {
                // نستخدم innerHTML للسماح بتنسيق HTML داخل الترجمة
                element.innerHTML = translations[lang][key];
            }
        });

        // ب. تحديث الـ Placeholders (للبحث والنماذج)
        document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
            const key = element.getAttribute('data-i18n-placeholder');
            if (translations[lang][key]) {
                element.placeholder = translations[lang][key];
            }
        });

        // ج. تحديث الاتجاه (RTL / LTR) والخطوط
        document.documentElement.lang = lang;
        if (lang === 'ar') {
            document.documentElement.dir = 'rtl';
            document.body.style.fontFamily = "'Cairo', sans-serif";
            
            // قلب أيقونات الأسهم لليمين
            document.querySelectorAll('.arrow-icon').forEach(el => {
                el.classList.remove('fa-arrow-right', 'fa-chevron-right');
                el.classList.add('fa-arrow-left', 'fa-chevron-left');
            });
        } else {
            document.documentElement.dir = 'ltr';
            document.body.style.fontFamily = "'Inter', sans-serif";
            
            // قلب أيقونات الأسهم لليسار
            document.querySelectorAll('.arrow-icon').forEach(el => {
                el.classList.remove('fa-arrow-left', 'fa-chevron-left');
                el.classList.add('fa-arrow-right', 'fa-chevron-right');
            });
        }

        // د. تحديث أزرار اللغة (Active State)
        const btns = document.querySelectorAll('.lang-btn, #lang-ar, #lang-en');
        btns.forEach(btn => {
            btn.classList.remove('active');
            // التحقق من النص داخل الزر أو الـ ID
            if ((btn.id && btn.id.includes(lang)) || (btn.innerText.toLowerCase() === lang)) {
                btn.classList.add('active');
            }
        });
        
        // حفظ اللغة في المتصفح
        localStorage.setItem('language', lang);
    }

    /**
     *  3. إعداد الأزرار
     */
    function setupLanguageSwitcher() {
        // نربط جميع الأزرار التي تغير اللغة
        const arBtns = document.querySelectorAll('#lang-ar, .lang-btn:nth-child(1)'); // افتراض أن الأول هو العربية
        const enBtns = document.querySelectorAll('#lang-en, .lang-btn:nth-child(2)'); // افتراض أن الثاني هو الإنجليزية
        
        // طريقة عامة لربط أي زر
        document.addEventListener('click', (e) => {
            if(e.target && (e.target.id === 'lang-ar' || e.target.innerText === 'AR')) {
                setLanguage('ar');
            }
            if(e.target && (e.target.id === 'lang-en' || e.target.innerText === 'EN')) {
                setLanguage('en');
            }
        });
    }
    
    /**
     *  4. التشغيل الأولي
     */
    function initialize() {
        // اللغة الافتراضية: المحفوظة أو العربية
        const savedLang = localStorage.getItem('language') || 'ar';
        
        setLanguage(savedLang);
        setupLanguageSwitcher();
    }

    // ابدأ التحميل
    loadTranslations();
});
