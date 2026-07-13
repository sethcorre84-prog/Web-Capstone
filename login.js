function login() {

    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;

    if (email === "admin" &&
        password === "123456") {

        window.location.href = "DashBoard.html";

    } else {

        alert("Invalid email or password.");

    }
}