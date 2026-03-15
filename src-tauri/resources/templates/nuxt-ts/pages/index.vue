<template>
  <main class="main">
    <h1>Hello World</h1>
    <p>Welcome to your Nuxt + TypeScript app.</p>
  </main>
</template>

<script setup lang="ts">
useHead({
  title: 'Nuxt App',
})
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

.main {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  text-align: center;
}

.main h1 {
  font-size: 3rem;
  margin-bottom: 1rem;
}

.main p {
  font-size: 1.2rem;
  color: #888;
}
</style>
