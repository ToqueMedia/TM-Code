import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <main>
      <h1>Hello World!</h1>
      <p>Welcome to your Angular app.</p>
    </main>
  `,
  styles: [`
    main {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      font-family: system-ui, -apple-system, sans-serif;
    }

    h1 {
      font-size: 2rem;
      color: #dd0031;
    }
  `]
})
export class AppComponent {
  title = 'angular-ts-template';
}
