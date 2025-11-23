document.addEventListener('DOMContentLoaded', () => {
    // هذا الكائن سيحتوي على جميع الترجمات بعد تحميلها
    const translations = {};

    /**
     *  1. تحميل ملف الترجمة (translations.json) من السيرفر
     */
    async function loadTranslations() {
        try {
            const response = await fetch('translations.json');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            // دمج الترجمات المحملة في الكائن الرئيسي
            Object.assign(translations, data);
        } catch (error) {
            console.error("Could not load translations file:", error);
        }
    }

    /**
     *  2. تطبيق اللغة المختارة على جميع العناصر في الصفحة
     *  @param {string} lang - اللغة المراد تطبيقها ('ar' or 'en')
     */
    function setLanguage(lang) {
        // التأكد من أن الترجمات لهذه اللغة موجودة
        if (!translations[lang]) return;

        // تحديث النصوص العادية (innerHTML)
        document.querySelectorAll('[data-key]').forEach(element => {
            const key = element.getAttribute('data-key');
            if (translations[lang][key]) {
                element.innerHTML = translations[lang][key];
            }
        });

        // --- الجزء المضاف: تحديث نصوص الـ placeholder ---
        document.querySelectorAll('[data-key-placeholder]').forEach(element => {
            const key = element.getAttribute('data-key-placeholder');
            if (translations[lang][key]) {
                element.placeholder = translations[lang][key];
            }
        });
        // ---------------------------------------------

        // تحديث لغة واتجاه الصفحة الرئيسية (<html>)
        document.documentElement.lang = lang;
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

        // تحديث حالة الأزرار (إظهار الزر النشط)
        const langArBtn = document.getElementById('lang-ar');
        const langEnBtn = document.getElementById('lang-en');
        if (langArBtn && langEnBtn) {
            langArBtn.classList.toggle('active', lang === 'ar');
            langEnBtn.classList.toggle('active', lang === 'en');
        }
        
        // حفظ اختيار المستخدم في التخزين المحلي للمتصفح
        localStorage.setItem('language', lang);
    }

    /**
     *  3. إعداد وظائف النقر لأزرار تغيير اللغة
     */
    function setupLanguageSwitcher() {
        const langArBtn = document.getElementById('lang-ar');
        const langEnBtn = document.getElementById('lang-en');
        
        if (langArBtn && langEnBtn) {
            langArBtn.addEventListener('click', () => setLanguage('ar'));
            langEnBtn.addEventListener('click', () => setLanguage('en'));
        }
    }
    
    /**
     *  4. الدالة الرئيسية التي يتم تشغيلها عند تحميل الصفحة
     */
    async function initialize() {
        // أولاً، نقوم بتحميل ملف الترجمات
        await loadTranslations();
        
        // ثانياً، نحدد اللغة التي يجب عرضها
        const savedLang = localStorage.getItem('language') || (navigator.language.startsWith('ar') ? 'ar' : 'en');
        
        // ثالثاً، نقوم بتطبيق اللغة وإعداد الأزرار
        setLanguage(savedLang);
        setupLanguageSwitcher();
    }

    // بدء تشغيل كل شيء
    initialize();
});
