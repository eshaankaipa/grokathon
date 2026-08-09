// src/popup.js
var elements = {
  status: document.querySelector("#status"),
  loading: document.querySelector("#account-loading"),
  signedOut: document.querySelector("#account-signed-out"),
  signedIn: document.querySelector("#account-signed-in"),
  authForm: document.querySelector("#email-auth-form"),
  email: document.querySelector("#auth-email"),
  password: document.querySelector("#auth-password"),
  connectWebsite: document.querySelector("#connect-website"),
  signIn: document.querySelector("#sign-in"),
  signUp: document.querySelector("#sign-up"),
  signOut: document.querySelector("#sign-out"),
  authMessage: document.querySelector("#auth-message"),
  avatar: document.querySelector("#avatar"),
  userName: document.querySelector("#user-name"),
  userDetail: document.querySelector("#user-detail")
};
function setMessage(element, message = "", error = false) {
  element.textContent = message;
  element.className = error ? "message error" : "message";
}
function showAuthState(auth) {
  elements.loading.classList.add("hidden");
  elements.signedIn.classList.toggle("hidden", !auth.user);
  elements.signedOut.classList.toggle("hidden", Boolean(auth.user));
  elements.status.textContent = auth.user ? "Connected" : auth.configured ? "Sign in" : "Setup";
  elements.status.className = `status ${auth.user ? "connected" : auth.configured ? "ready" : "setup"}`;
  if (!auth.configured) {
    elements.signIn.disabled = true;
    elements.signUp.disabled = true;
    elements.connectWebsite.disabled = true;
    elements.email.disabled = true;
    elements.password.disabled = true;
    setMessage(elements.authMessage, "xmarket could not load its account configuration.", true);
  } else {
    elements.signIn.disabled = false;
    elements.signUp.disabled = false;
    elements.connectWebsite.disabled = false;
    elements.email.disabled = false;
    elements.password.disabled = false;
  }
  if (auth.user) {
    elements.userName.textContent = auth.user.displayName;
    const identity = auth.user.xHandle ? `@${auth.user.xHandle.replace(/^@/, "")}` : auth.user.email || "Connected";
    elements.userDetail.textContent = auth.balance == null ? identity : `${identity} \xB7 ${Number(auth.balance).toFixed(2)} credits`;
    elements.avatar.textContent = auth.user.displayName.slice(0, 1).toUpperCase();
    if (auth.user.avatarUrl) {
      const image = document.createElement("img");
      image.src = auth.user.avatarUrl;
      image.alt = "";
      elements.avatar.replaceChildren(image);
    }
  }
}
async function refreshAuth() {
  const response = await chrome.runtime.sendMessage({ type: "SIGNAL_GET_AUTH" });
  if (!response?.ok) {
    elements.loading.textContent = response?.error || "Could not load the account.";
    elements.status.textContent = "Error";
    elements.status.className = "status setup";
    return;
  }
  showAuthState(response);
}
function setAuthLoading(loading) {
  elements.connectWebsite.disabled = loading;
  elements.signIn.disabled = loading;
  elements.signUp.disabled = loading;
  elements.email.disabled = loading;
  elements.password.disabled = loading;
}
elements.connectWebsite.addEventListener("click", async () => {
  setAuthLoading(true);
  setMessage(elements.authMessage, "Opening the xmarket website\u2026");
  const response = await chrome.runtime.sendMessage({ type: "SIGNAL_CONNECT_WEBSITE" });
  if (!response?.ok) {
    setAuthLoading(false);
    setMessage(elements.authMessage, response?.error || "Could not connect the website account.", true);
    return;
  }
  await refreshAuth();
  setAuthLoading(false);
});
function getCredentials() {
  if (!elements.authForm.reportValidity()) return null;
  return {
    email: elements.email.value.trim(),
    password: elements.password.value
  };
}
elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const credentials = getCredentials();
  if (!credentials) return;
  setAuthLoading(true);
  setMessage(elements.authMessage, "Signing in\u2026");
  const response = await chrome.runtime.sendMessage({
    type: "SIGNAL_SIGN_IN_EMAIL",
    ...credentials
  });
  if (!response?.ok) {
    setAuthLoading(false);
    setMessage(elements.authMessage, response?.error || "Sign-in failed.", true);
    return;
  }
  elements.password.value = "";
  await refreshAuth();
  setAuthLoading(false);
});
elements.signUp.addEventListener("click", async () => {
  const credentials = getCredentials();
  if (!credentials) return;
  setAuthLoading(true);
  setMessage(elements.authMessage, "Creating account\u2026");
  const response = await chrome.runtime.sendMessage({
    type: "SIGNAL_SIGN_UP_EMAIL",
    ...credentials
  });
  if (!response?.ok) {
    setAuthLoading(false);
    setMessage(elements.authMessage, response?.error || "Could not create the account.", true);
    return;
  }
  elements.password.value = "";
  if (response.confirmationRequired) {
    setMessage(elements.authMessage, "Check your email to confirm the account, then sign in here.");
  } else {
    await refreshAuth();
  }
  setAuthLoading(false);
});
elements.signOut.addEventListener("click", async () => {
  elements.signOut.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: "SIGNAL_SIGN_OUT" });
  if (!response?.ok) setMessage(elements.authMessage, response?.error || "Sign-out failed.", true);
  else await refreshAuth();
  elements.signOut.disabled = false;
});
await refreshAuth();
//# sourceMappingURL=popup.js.map
