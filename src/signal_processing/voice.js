// Browser speech-to-text input. The recognized words go through the same NLP
// request as typed text; no audio is treated as a navigation command directly.
export function attachVoiceInput({ button, input, form, status }) {
  const Recognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    button.disabled = true;
    button.title = "Speech recognition is unavailable in this browser";
    return { stop() {} };
  }
  const recognition = new Recognition();
  recognition.lang = "ar-EG";
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  let listening = false;
  recognition.onresult = (event) => {
    const transcript = event.results[0]?.[0]?.transcript?.trim();
    if (!transcript) return;
    input.value = transcript;
    status.textContent = `Heard: ${transcript}`;
    form.requestSubmit();
  };
  recognition.onerror = (event) => {
    status.textContent = `Microphone: ${event.error}`;
  };
  recognition.onend = () => {
    listening = false;
    button.textContent = "Speak";
    button.setAttribute("aria-pressed", "false");
  };
  button.addEventListener("click", () => {
    if (listening) {
      recognition.stop();
      return;
    }
    try {
      recognition.start();
      listening = true;
      button.textContent = "Listening…";
      button.setAttribute("aria-pressed", "true");
    } catch (error) {
      status.textContent = `Microphone: ${error.message}`;
    }
  });
  return { stop: () => listening && recognition.stop() };
}
