"use client";

import { useEffect, useState } from "react";
import { getApp, getApps, initializeApp } from "firebase/app";
import { getStorage, ref, uploadBytesResumable } from "firebase/storage";
import { GoogleAuthProvider, OAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";

// The web config is public by design; access is controlled by Firebase Auth's
// authorized domains and security rules, not by hiding these values.
const config = {
  apiKey: "AIzaSyCQvRg4otQTZ_rY_hFYPk5uV4kNWfFWWWc",
  authDomain: "getmotion-5c2a2.firebaseapp.com",
  projectId: "getmotion-5c2a2",
  storageBucket: "getmotion-5c2a2.firebasestorage.app",
  messagingSenderId: "479490240979",
  appId: "1:479490240979:web:806602f10b8b75e50bff26",
};

const app = () => (getApps().length ? getApp() : initializeApp(config));
const auth = () => getAuth(app());

export type Provider = "google" | "apple";

export function signIn(provider: Provider) {
  const p = provider === "google" ? new GoogleAuthProvider() : new OAuthProvider("apple.com");
  if (provider === "apple") (p as OAuthProvider).addScope("email");
  return signInWithPopup(auth(), p);
}

export const signOutUser = () => signOut(auth());

// The signed-in visitor, or null; undefined until Firebase has restored the session.
export function useUser() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => onAuthStateChanged(auth(), setUser), []);
  return user;
}

// Firebase error codes, said plainly. Closing the popup is not an error worth showing.
export function authMessage(e: unknown): string | null {
  const code = (e as { code?: string })?.code ?? "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return null;
  if (code === "auth/popup-blocked") return "Your browser blocked the sign-in window. Allow pop-ups for getmotion.art and try again.";
  if (code === "auth/operation-not-allowed" || code === "auth/configuration-not-found") return "This sign-in option isn’t switched on yet.";
  if (code === "auth/unauthorized-domain") return "Sign-in isn’t allowed from this address yet.";
  if (code === "auth/account-exists-with-different-credential") return "You already signed in another way with this email. Use that one.";
  return "Sign-in didn’t go through. Try again.";
}

// Authorization header for our own APIs, from the signed-in visitor's ID token.
export async function authHeader(): Promise<Record<string, string>> {
  const u = auth().currentUser;
  return u ? { Authorization: `Bearer ${await u.getIdToken()}` } : {};
}

// Uploads into the visitor's own folder (storage.rules allow nothing else), with progress.
export function upload(path: string, data: Blob, onBytes: (sent: number) => void) {
  return new Promise<string>((res, rej) => {
    const task = uploadBytesResumable(ref(getStorage(app()), path), data, { contentType: data.type });
    task.on("state_changed", (s) => onBytes(s.bytesTransferred), rej, () => res(path));
  });
}

// For tests on localhost only: sign in with a custom token minted by the Admin SDK.
if (typeof window !== "undefined" && location.hostname === "localhost")
  (window as unknown as { __signInWithToken: (t: string) => Promise<unknown> }).__signInWithToken = async (t: string) =>
    (await import("firebase/auth")).signInWithCustomToken(auth(), t);
