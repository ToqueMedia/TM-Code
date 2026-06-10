const apiKey = process.env.GEMINI_API_KEY;
fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey
  },
  body: JSON.stringify({
    model: "gemini-3.1-pro-preview",
    messages: [{role: "user", content: "hello"}],
    thinkingBudget: 8192
  })
}).then(r => r.text()).then(console.log).catch(console.error);
