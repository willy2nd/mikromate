
package com.mikromate.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

private const val API_BASE_URL = "https://mikromate.onrender.com"

private val httpClient = OkHttpClient()

private val jsonType =
    "application/json; charset=utf-8".toMediaType()

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MikroMateApp()
        }
    }
}

private suspend fun authenticate(
    endpoint: String,
    data: JSONObject
): JSONObject = withContext(Dispatchers.IO) {

    val body = data.toString().toRequestBody(jsonType)

    val request = Request.Builder()
        .url("$API_BASE_URL$endpoint")
        .post(body)
        .build()

    httpClient.newCall(request).execute().use { response ->

        val result = response.body?.string().orEmpty()
        val json = if (result.isNotBlank()) {
            JSONObject(result)
        } else {
            JSONObject()
        }

        if (!response.isSuccessful) {
            throw Exception(
                json.optString(
                    "error",
                    "Request failed: ${response.code}"
                )
            )
        }

        json
    }
}

@Composable
fun MikroMateApp() {
    var token by remember { mutableStateOf<String?>(null) }
    var userName by remember { mutableStateOf("") }
    var userEmail by remember { mutableStateOf("") }

    var isRegister by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var countryCode by remember { mutableStateOf("KE") }
    var password by remember { mutableStateOf("") }

    var loading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf("") }

    val scope = rememberCoroutineScope()

    MaterialTheme {
        Surface(
            modifier = Modifier.fillMaxSize()
        ) {
            if (token == null) {

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(24.dp),
                    verticalArrangement = Arrangement.Center
                ) {

                    Text(
                        "MikroMate",
                        style = MaterialTheme.typography.headlineLarge
                    )

                    Spacer(Modifier.height(8.dp))

                    Text(
                        "Connect. Work. Earn.",
                        style = MaterialTheme.typography.titleMedium
                    )

                    Spacer(Modifier.height(28.dp))

                    Text(
                        if (isRegister) "Create your account"
                        else "Welcome back",
                        style = MaterialTheme.typography.headlineSmall
                    )

                    Spacer(Modifier.height(16.dp))

                    if (isRegister) {
                        OutlinedTextField(
                            value = name,
                            onValueChange = { name = it },
                            label = { Text("Full name") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            enabled = !loading
                        )

                        Spacer(Modifier.height(10.dp))

                        OutlinedTextField(
                            value = phone,
                            onValueChange = { phone = it },
                            label = { Text("Phone number (optional)") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            enabled = !loading
                        )

                        Spacer(Modifier.height(10.dp))

                        OutlinedTextField(
                            value = countryCode,
                            onValueChange = {
                                countryCode = it.uppercase().take(2)
                            },
                            label = { Text("Country code (e.g. KE)") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            enabled = !loading
                        )

                        Spacer(Modifier.height(10.dp))
                    }

                    OutlinedTextField(
                        value = email,
                        onValueChange = { email = it },
                        label = { Text("Email address") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        enabled = !loading,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Email
                        )
                    )

                    Spacer(Modifier.height(10.dp))

                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("Password") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        enabled = !loading,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Password
                        )
                    )

                    Spacer(Modifier.height(18.dp))

                    if (errorMessage.isNotBlank()) {
                        Text(
                            errorMessage,
                            color = MaterialTheme.colorScheme.error
                        )
                        Spacer(Modifier.height(12.dp))
                    }

                    Button(
                        onClick = {
                            errorMessage = ""

                            if (email.isBlank() ||
                                password.isBlank() ||
                                (isRegister && name.isBlank())
                            ) {
                                errorMessage =
                                    "Please complete all required fields."
                                return@Button
                            }

                            if (isRegister && password.length < 8) {
                                errorMessage =
                                    "Password must contain at least 8 characters."
                                return@Button
                            }

                            if (isRegister &&
                                !Regex("^[A-Z]{2}$").matches(countryCode)
                            ) {
                                errorMessage =
                                    "Enter a valid two-letter country code."
                                return@Button
                            }

                            loading = true

                            scope.launch {
                                try {
                                    val data = JSONObject().apply {
                                        put("email", email.trim())
                                        put("password", password)

                                        if (isRegister) {
                                            put("name", name.trim())
                                            put("country_code", countryCode)

                                            if (phone.isNotBlank()) {
                                                put("phone", phone.trim())
                                            }
                                        }
                                    }

                                    val endpoint = if (isRegister) {
                                        "/api/auth/register"
                                    } else {
                                        "/api/auth/login"
                                    }

                                    val result = authenticate(
                                        endpoint,
                                        data
                                    )

                                    val account =
                                        result.optJSONObject("user")

                                    val receivedToken =
                                        result.optString("token")

                                    if (receivedToken.isBlank()) {
                                        throw Exception(
                                            "The server did not return a login token."
                                        )
                                    }

                                    token = receivedToken
                                    userName = account?.optString(
                                        "name",
                                        name
                                    ) ?: name

                                    userEmail = account?.optString(
                                        "email",
                                        email
                                    ) ?: email

                                    password = ""
                                    errorMessage = ""

                                } catch (e: Exception) {
                                    errorMessage =
                                        e.message ?: "Connection failed."
                                } finally {
                                    loading = false
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !loading
                    ) {
                        if (loading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp
                            )
                        } else {
                            Text(
                                if (isRegister) "Create Account"
                                else "Login"
                            )
                        }
                    }

                    Spacer(Modifier.height(12.dp))

                    TextButton(
                        onClick = {
                            isRegister = !isRegister
                            errorMessage = ""
                        },
                        enabled = !loading,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            if (isRegister)
                                "Already registered? Login"
                            else
                                "New to MikroMate? Create an account"
                        )
                    }
                }

            } else {

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(24.dp),
                    verticalArrangement = Arrangement.Center
                ) {
                    Text(
                        "Welcome to MikroMate!",
                        style = MaterialTheme.typography.headlineMedium
                    )

                    Spacer(Modifier.height(16.dp))

                    Text("Hello, $userName")

                    Spacer(Modifier.height(8.dp))

                    Text("Account: $userEmail")

                    Spacer(Modifier.height(20.dp))

                    Text(
                        "Your account is connected to the MikroMate service.",
                        style = MaterialTheme.typography.bodyLarge
                    )

                    Spacer(Modifier.height(24.dp))

                    Button(
                        onClick = {
                            token = null
                            userName = ""
                            userEmail = ""
                            email = ""
                            password = ""
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Logout")
                    }
                }
            }
        }
    }
}
