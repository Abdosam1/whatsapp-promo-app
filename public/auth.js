document.addEventListener('DOMContentLoaded', () => {
    // --- تحديد الصفحات ---
    const isLoginPage = !!document.getElementById('login-form');
    const isSignupPage = !!document.getElementById('signup-form');

    // --- عناصر مشتركة ---
    const messageContainer = document.getElementById('message-container') || document.getElementById('error-message');

    // ==========================================================
    // ==============  منطق صفحة إنشاء حساب (Signup)  ==============
    // ==========================================================
    if (isSignupPage) {
        const signupForm = document.getElementById('signup-form');

        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault(); // منع إرسال الفورم بالطريقة التقليدية

            const name = signupForm.querySelector('#name').value;
            const email = signupForm.querySelector('#email').value;
            const password = signupForm.querySelector('#password').value;

            // إعادة تعيين الرسائل السابقة
            displayMessage('');

            try {
                const response = await fetch('/api/auth/signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, email, password })
                });

                const data = await response.json();

                if (!response.ok) {
                    // عرض رسالة الخطأ من السيرفر
                    throw new Error(data.message || 'فشل التسجيل');
                }

                // عرض رسالة النجاح
                displayMessage(data.message, 'success');
                signupForm.reset(); // تفريغ الفورم

            } catch (error) {
                displayMessage(error.message, 'error');
            }
        });
    }

    // ==========================================================
    // ==============  منطق صفحة تسجيل الدخول (Login)  =============
    // ==========================================================
    if (isLoginPage) {
        const loginForm = document.getElementById('login-form');

        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const email = loginForm.querySelector('#email').value;
            const password = loginForm.querySelector('#password').value;

            displayMessage('');

            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.message || 'فشل تسجيل الدخول');
                }

                // =================================================
                // ==========  هنا تم إجراء التعديل المهم  ==========
                // =================================================
                
                // --- نجاح تسجيل الدخول ---

                // الخطوة 1: إنشاء أوبجيكت بمعلومات المستخدم من جواب السيرفر
                // ملاحظة: تأكد من أن السيرفر ديالك كيرجع ليك 'userId' مع التوكن
                const userInfoToStore = {
                    userId: data.userId, // هادي أهم معلومة كنحتاجوها
                    token: data.token    // نقدروا نخزنو حتى التوكن هنا
                };

                // الخطوة 2: تخزين التوكن (مزيان تخليها إلى كنتي كتستعملها فبلاصة أخرى)
                localStorage.setItem('authToken', data.token);

                // الخطوة 3: تخزين معلومات المستخدم بالإسم الصحيح لي كنقلبو عليه
                // هادي هي أهم خطوة فالعملية كلها
                localStorage.setItem('userInfo', JSON.stringify(userInfoToStore));

                // الخطوة 4: توجيه المستخدم إلى لوحة التحكم
                window.location.href = '/dashboard.html';
                
                // =================================================
                // ============= نهاية التعديل المهم ===============
                // =================================================

            } catch (error) {
                displayMessage(error.message, 'error');
            }
        });
    }

    // --- دالة مساعدة لعرض الرسائل ---
    function displayMessage(message, type = 'error') {
        if (!messageContainer) return;

        messageContainer.textContent = message;
        messageContainer.className = 'message'; // إعادة التعيين
        
        if (message) {
            if (type === 'error') {
                messageContainer.classList.add('error');
            } else {
                messageContainer.classList.add('success');
            }
            messageContainer.style.display = 'block';
        } else {
            messageContainer.style.display = 'none';
        }
    }
});
