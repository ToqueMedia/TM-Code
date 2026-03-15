<template>
  <div class="app">
    <h1>Hello World</h1>
    <p>Welcome to your Vue + TypeScript + Vite app.</p>
  </div>
</template>

<script setup lang="ts">
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background-color: #242424;
  color: #ffffffde;
  min-height: 100vh;
}

.app {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  text-align: center;
}

.app h1 {
  font-size: 3rem;
  margin-bottom: 1rem;
}

.app p {
  font-size: 1.2rem;
  color: #888;
}
</style>
