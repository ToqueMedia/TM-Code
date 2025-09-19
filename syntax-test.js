// ToqueMedia Studio Syntax Highlighting Test
// Este arquivo testa as cores customizadas do Monaco Editor

/* 
 * Bloco de comentários para testar
 * diferentes tipos de comentários
 */

// Palavras-reservadas e controle de fluxo
import React, { useState, useEffect } from 'react';
import { Editor } from '@monaco-editor/react';

const keywords = ['const', 'let', 'var', 'function', 'class', 'interface'];

// Função principal para testar highlighting
function demonstrateSyntaxHighlighting() {
  // Variáveis e constantes
  const PI = 3.14159;
  let counter = 0;
  var name = "ToqueMedia Studio";
  
  // Números em diferentes bases
  const decimal = 42;
  const hex = 0xFF;
  const binary = 0b1010;
  const float = 3.14159;
  
  // Strings e template strings
  const simpleString = 'Hello World';
  const doubleQuoted = "JavaScript";
  const templateString = `Counter value is: ${counter}`;
  
  // Estruturas de controle
  if (counter > 0) {
    console.log('Positive counter');
  } else if (counter < 0) {
    console.warn('Negative counter');
  } else {
    console.error('Zero counter');
  }
  
  // Loops
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) continue;
    console.log(`Odd number: ${i}`);
  }
  
  while (counter < 100) {
    counter++;
    if (counter === 50) break;
  }
  
  // Try/catch
  try {
    const result = riskyOperation();
    return result;
  } catch (error) {
    throw new Error('Something went wrong');
  } finally {
    cleanup();
  }
}

// Classe para testar OOP
class CustomEditor {
  constructor(theme = 'dark') {
    this.theme = theme;
    this.isActive = false;
  }
  
  // Método estático
  static getInstance() {
    if (!this.instance) {
      this.instance = new CustomEditor();
    }
    return this.instance;
  }
  
  // Métodos getter/setter
  get currentTheme() {
    return this.theme;
  }
  
  set currentTheme(newTheme) {
    this.theme = newTheme;
  }
  
  // Método assíncrono
  async loadConfiguration() {
    const config = await fetch('/api/config');
    return config.json();
  }
  
  // Arrow function
  updateStatus = (status) => {
    this.isActive = status;
  }
}

// Operadores
const math = (a, b) => {
  return {
    sum: a + b,
    diff: a - b,
    mult: a * b,
    div: a / b,
    mod: a % b,
    power: a ** b,
    equal: a === b,
    notEqual: a !== b,
    greater: a > b,
    less: a < b,
    and: a && b,
    or: a || b,
    not: !a
  };
};

// Array e Object literals
const colors = ['red', 'green', 'blue', 'yellow'];
const config = {
  editor: {
    theme: 'custom',
    fontSize: 14,
    wordWrap: true,
    lineNumbers: 'on'
  },
  features: {
    intelliSense: true,
    syntaxHighlighting: true,
    autoComplete: true
  }
};

// Destructuring
const { editor: { theme, fontSize } } = config;
const [first, second, ...rest] = colors;

// Spread operator
const newConfig = { ...config, version: '2.0' };
const allColors = ['black', 'white', ...colors];

// Promises e async/await
const loadData = async () => {
  try {
    const response = await fetch('/api/data');
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Failed to load data:', error);
    return null;
  }
};

// Regular expressions
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex = /^\(\d{3}\)\s\d{3}-\d{4}$/;

// Exports
export default CustomEditor;
export { demonstrateSyntaxHighlighting, loadData };
export const VERSION = '1.0.0';

// Este arquivo demonstra:
// 💜 Keywords em ROXO NEGRITO - Destaque especial!
// 💚 Strings em verde brilhante
// 🧡 Números em laranja vibrante
// 💭 Comentários em azul suave e itálico
// 💛 Funções em amarelo dourado
// 🔮 Tipos e classes em roxo elegante
// 🩷 Constantes em rosa vibrante
// 💜 Operadores em roxo claro
//
// ✨ NOVA PALETA: Todas as keywords agora em ROXO para melhor visibilidade!
