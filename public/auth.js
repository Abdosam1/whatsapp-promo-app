const API_BASE_URL = '/api/auth';

const signupForm = document.getElementById('signup-form');
const loginForm = document.getElementById('login-form');
const errorMessageDiv = document.getElementById('error-message');

if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMessageDiv.textContent = '';
        
        // قراءة القيم من الحقول
        const fullNameInput = signupForm.querySelector('#full_name');
        const confirmPasswordInput = signupForm.querySelector('#confirm_password');

        const fullName = fullNameInput ? fullNameInput.value.trim() : '';
        const email = signupForm.email.value.trim();
        const password = signupForm.password.value;
        const confirmPassword = confirmPasswordInput ? confirmPasswordInput.value : '';

        // التحقق من تطابق كلمات المرور
        if (password !== confirmPassword) {
            errorMessageDiv.textContent = 'كلمتا المرور غير متطابقتان.';
            return;
        }
        
        // التحقق من تعبئة جميع الحقول
        if (!fullName || !email || !password || !confirmPassword) {
            errorMessageDiv.textContent = 'جميع الحقول مطلوبة.';
            return;
        }

        try {
            const response = await fetch(`${API_BASE_URL}/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: fullName, email, password })
            });

            const data = await response.json();

            if (!response.ok) throw new Error(data.message || 'حدث خطأ أثناء التسجيل.');

            // بعد النجاح: إعلام المستخدم وتحويله لصفحة تأكيد الإيميل
            alert('تم إرسال رابط التفعيل إلى بريدك الإلكتروني. يرجى التحقق من صندوق الوارد.');
            window.location.replace('email-confirmation.html'); 

        } catch (error) {
            errorMessageDiv.textContent = error.message;
        }
    });
}

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMessageDiv.textContent = '';
        const email = loginForm.email.value.trim();
        const password = loginForm.password.value;

        if (!email || !password) {
            errorMessageDiv.textContent = 'يرجى إدخال البريد الإلكتروني وكلمة المرور.';
            return;
        }

        try {
            const response = await fetch(`${API_BASE_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await response.json();
            
            if (!response.ok) throw new Error(data.message || 'فشل تسجيل الدخول.');

            // تخزين التوكن في localStorage
            localStorage.setItem('authToken', data.token);
            
            // التوجيه للداشبورد
            window.location.replace('/dashboard'); 
            
        } catch (error) {
            errorMessageDiv.textContent = error.message;
        }
    });
}
