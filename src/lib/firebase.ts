"use client";

import { useEffect, useState } from "react";
import { getApp, getApps, initializeApp } from "firebase/app";
import { GoogleAuthProvider, OAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";

// The web config is public by design; access is controlled by Firebase Auth's
// authorized domains and security rules, not by hiding these values.
const config = {
  apiKey: "AIzaSyCXFuIeCPEOqXF-4piVacmzYkHFb92Xwpg",
  authDomain: "getmotion-art.firebaseapp.com",
  projectId: "getmotion-art",
  storageBucket: "getmotion-art.firebasestorage.app",
  messagingSenderId: "828412556254",
  appId: "1:828412556254:web:2544fa1b4fec680561634f",
};

const auth = () => getAuth(getApps().length ? getApp() : initializeApp(config));

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
