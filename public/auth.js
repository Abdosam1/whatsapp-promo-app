// public/auth.js

const API_BASE_URL = '/api/auth';

const signupForm = document.getElementById('signup-form');
const loginForm = document.getElementById('login-form');
const errorMessageDiv = document.getElementById('error-message');

if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMessageDiv.textContent = '';
        const email = signupForm.email.value;
        const password = signupForm.password.value;
        try {
            const response = await fetch(`${API_BASE_URL}/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message);
            alert('تم إنشاء حسابك بنجاح! يمكنك الآن تسجيل الدخول.');
            window.location.href = 'login.html';
        } catch (error) {
            errorMessageDiv.textContent = error.message;
        }
    });
}

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMessageDiv.textContent = '';
        const email = loginForm.email.value;
        const password = loginForm.password.value;
        try {
            const response = await fetch(`${API_BASE_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message);
            localStorage.setItem('authToken', data.token);
            window.location.href = 'dashboard.html'; // التأكد من التوجيه الصحيح
        } catch (error) {
            errorMessageDiv.textContent = error.message;
        }
    });
}