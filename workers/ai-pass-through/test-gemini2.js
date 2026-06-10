const apiKey = process.env.GEMINI_API_KEY;
fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey
  },
  body: JSON.stringify({
    model: "gemini-3.1-pro-preview",
    messages: [{role: "system", content: "You are an AI"}, {role: "user", content: "hello"}],
    temperature: 0.6,
    max_completion_tokens: 8192,
    top_p: 0.95
  })
}).then(r => r.json()).then(console.log).catch(console.error);
