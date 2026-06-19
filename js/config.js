const CONFIG = {
  // After deploying the backend on Render, replace the value below with your
  // actual backend URL  →  e.g. 'https://clipshare-api.onrender.com'
  PROD_API_URL: "https://backendcopypaste.onrender.com",

  get API_URL() {
    const isLocal = ["localhost", "127.0.0.1", ""].includes(
      window.location.hostname,
    );
    return isLocal ? "http://localhost:5000" : this.PROD_API_URL;
  },
};
