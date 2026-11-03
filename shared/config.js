// Settings fixed at release time.
//
// GOOGLE_CLIENT_ID: the Google app both the extension and the phone page use
// to reach your Drive. Not a secret (every page using Google sign-in shows
// its client ID). Empty: you paste one under "Phone" in the dashboard.
// PHONE_URL: where the phone page is hosted (for example on GitHub Pages).
// Empty: the dashboard asks for the address to make the QR code.
// SIGNIN_URL: the sign-in helper (signin-helper/worker.js) that keeps the
// phone signed in. Empty: the phone signs in for an hour at a time.
export const GOOGLE_CLIENT_ID = '638508448599-n5jmqgl5aeusl7sou0c1t9asbjlsq6ah.apps.googleusercontent.com';
export const PHONE_URL = 'https://adarsh-pandey07.github.io/bookmark-vault-phone/';
export const SIGNIN_URL = '';
