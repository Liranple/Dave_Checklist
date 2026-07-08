export const firebaseConfig = {
  apiKey: "AIzaSyC3jvRgKewpZPUeguCfK7jjaWralaD5NrA",
  authDomain: "davechecklist-60f03.firebaseapp.com",
  projectId: "davechecklist-60f03",
  storageBucket: "davechecklist-60f03.firebasestorage.app",
  messagingSenderId: "1043587726343",
  appId: "1:1043587726343:web:081ed59d3a0096de4e7ea2",
  measurementId: "G-PFWN581NWV",
};

export function isFirebaseConfigured() {
  return Object.values(firebaseConfig).every((value) => typeof value === "string" && value.trim());
}
