# HTML Assignment PDF Generator

A Node.js web application that accepts user uploads of `.zip` files containing HTML solutions (`q1.html`, `q2.html`, etc.), CSS, and media assets, generating an A4 PDF with custom borders, dynamic page numbers, and student footers.

---

## 🛠️ Local Setup & Running

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start the Server**:
   ```bash
   node server.js
   ```

3. **Open in Browser**:
   Navigate to `http://localhost:3000`

---

## 🚀 How to Deploy for Free (Render.com)

Render provides free hosting for Docker containers with Node.js & Chromium.

### Step 1: Push to GitHub
Run these commands in your project directory:
```bash
git init
git add .
git commit -m "Deploy PDF Generator"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

### Step 2: Deploy on Render
1. Go to [render.com](https://render.com) and sign up for a free account.
2. Click **New +** $\rightarrow$ **Web Service**.
3. Connect your GitHub repository.
4. Select **Docker** as the Runtime (Render auto-detects `Dockerfile`).
5. Choose **Free Instance Type**.
6. Click **Create Web Service**.

Render will automatically build the Docker container and give you a live website link (`https://your-app.onrender.com`).
