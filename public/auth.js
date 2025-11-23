document.addEventListener('DOMContentLoaded', () => {
    // --- تحديد ما إذا كنا في صفحة تسجيل الدخول أو إنشاء حساب ---
    const isLoginPage = !!document.getElementById('login-form');
    const isSignupPage = !!document.getElementById('signup-form');

    // --- عنصر عرض الرسائل ---
    const messageContainer = document.getElementById('message-container') || document.getElementById('error-message');

    // ==========================================================
    // ==============  منطق صفحة إنشاء حساب (Signup)  ==============
    // ==========================================================
    if (isSignupPage) {
        const signupForm = document.getElementById('signup-form');

        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = signupForm.querySelector('#name').value;
            const email = signupForm.querySelector('#email').value;
            const password = signupForm.querySelector('#password').value;
            displayMessage('جاري إنشاء الحساب...', 'info');
            try {
                const response = await fetch('/api/auth/signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, email, password })
                });
                const data = await response.json();
                if (!response.ok) { throw new Error(data.message || 'فشل التسجيل'); }
                displayMessage(data.message, 'success');
                signupForm.reset();
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
            displayMessage('جاري تسجيل الدخول...', 'info');

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
                
                // --- [ هذا هو الجزء الأهم الذي يقرر أين يذهب المستخدم ] ---

                // الخطوة 1: دائماً نخزن التوكن الذي أعطاه لنا السيرفر
                localStorage.setItem('authToken', data.token);

                // الخطوة 2: نقرر أين سنوجه المستخدم بناءً على جواب السيرفر
                if (data.subscriptionStatus === 'expired') {
                    // إذا كان الاشتراك منتهياً، نوجهه لصفحة التفعيل
                    displayMessage('اشتراكك منتهي. جاري توجيهك لصفحة التفعيل...', 'info');
                    window.location.href = '/activate.html';
                } else {
                    // إذا كان الاشتراك صالحاً، نوجهه للداشبورد
                    displayMessage('تم تسجيل الدخول بنجاح!', 'success');
                    window.location.href = '/dashboard.html';
                }
                // --- [ نهاية الجزء المهم ] ---

            } catch (error) {
                displayMessage(error.message, 'error');
            }
        });
    }

    // --- دالة مساعدة لعرض الرسائل ---
    function displayMessage(message, type = 'error') {
        if (!messageContainer) return;
        messageContainer.textContent = message;
        messageContainer.className = 'message';
        if (message) {
            messageContainer.classList.add(type); // 'error', 'success', or 'info'
            messageContainer.style.display = 'block';
        } else {
            messageContainer.style.display = 'none';
        }
    }
});
