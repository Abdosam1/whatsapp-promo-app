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

            displayMessage('');

            try {
                const response = await fetch('/api/auth/signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, email, password })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.message || 'فشل التسجيل');
                }

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

                // --- نجاح تسجيل الدخول (تم التعديل هنا) ---

                // الخطوة 1: تخزين التوكن فقط في ذاكرة المتصفح
                localStorage.setItem('authToken', data.token);

                // الخطوة 2: توجيه المستخدم إلى لوحة التحكم
                window.location.href = '/dashboard.html';

            } catch (error)
             {
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
            messageContainer.classList.add(type === 'error' ? 'error' : 'success');
            messageContainer.style.display = 'block';
        } else {
            messageContainer.style.display = 'none';
        }
    }
});
