// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAUHQe9hXSF3wI-et48Km5fs23eSEjMyW0",
  authDomain: "peakpath-ccd4a.firebaseapp.com",
  projectId: "peakpath-ccd4a",
  storageBucket: "peakpath-ccd4a.firebasestorage.app",
  messagingSenderId: "153325648552",
  appId: "1:153325648552:web:637b98f31cab359923a09d",
  measurementId: "G-1EEW8LSELB"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };