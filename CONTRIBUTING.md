# Contributing to reviewbuddy

Thank you for your interest in contributing to **reviewbuddy**! We welcome community contributions to help improve this AI code reviewer. Following these guidelines helps ensure a smooth development process for everyone.

---

## Code of Conduct
By participating in this project, you agree to treat all contributors with respect, maintain a welcoming environment, and help ensure open source remains inclusive.

---

## How Can I Contribute?

### 1. Reporting Bugs & Feedback
Before creating a bug report, please check our open issues to ensure it hasn't been reported yet. If you find a new bug, please open a new issue and include:
*   Steps to replicate the issue.
*   Your local environment setup (Node version, OS).
*   The model provider you were using (Ollama, Groq, Gemini, etc.).

### 2. Suggesting Features
Have an idea for a new provider, better prompting mechanics, or output formatting? Open an issue detailing your feature request and how it improves the application.

### 3. Submitting Pull Requests (PRs)
Ready to make code changes? Use the following workflow:

1.  **Fork** the repository on GitHub.
2.  **Clone** your fork locally:
    ```bash
    git clone https://github.com
    cd reviewbuddy
    ```
3.  **Create a new branch** off `main` for your work. Keep branch names descriptive:
    ```bash
    git checkout -b feature/amazing-new-feature
    # OR for bug fixes
    git checkout -b fix/issue-description
    ```
4.  **Implement your changes.** Make sure your changes are thoroughly covered by unit tests.
5.  **Commit your changes** with clear, concise messages.
6.  **Push** to your fork:
    ```bash
    git push origin feature/amazing-new-feature
    ```
7.  **Open a Pull Request** against our `main` branch. 

---

## Local Development Setup

### System Requirements
*   **Node.js 18** or newer (`node --version`)
*   **Ollama 0.5+** running locally (if testing local models)

### Testing Your Changes
Because **reviewbuddy** has **no external runtime dependencies**, you do not need to run an `npm install` command to get started! 

1. **Run the Test Suite**
   Ensure all existing logic remains intact by executing the test command:
   ```bash
   npm test
   ```

2. **Run a Local Review Test**
   Test how your changes handle local or buggy diffs using a specific local model:
   
   *On macOS / Linux:*
   ```bash
   OLLAMA_MODEL="qwen2.5-coder:7b" npm run review
   ```
   *On Windows (PowerShell):*
   ```powershell
   $env:OLLAMA_MODEL = "qwen2.5-coder:7b"
   npm run review
   ```

3. **Verify Context Traps**
   Verify the codebase's false-positive prevention mechanisms by feeding it the built-in context trap test file:
   ```bash
   npm run review -- samples/context-trap.diff --repo-dir samples/context-trap
   ```

---

## Style Guidelines

*   **Zero External Dependencies:** To keep the tool lightweight and fast, do not introduce new production dependencies to `package.json`. Code execution must remain native to Node.js built-ins.
*   **Error Isolation:** If a single file fails to review during parallel execution, ensure the tool handles it cleanly without crashing the entire worker loop.
