
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
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

private const val API_BASE_URL = "https://mikromate.onrender.com"

private val httpClient = OkHttpClient()
private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

data class MikroTask(
    val id: String,
    val title: String,
    val description: String,
    val category: String,
    val reward: String,
    val currency: String,
    val owner: String
)

data class MikroApplication(
    val taskId: String,
    val title: String,
    val status: String,
    val reward: String,
    val currency: String
)

data class PosterApplication(
    val applicationId: String, val taskId: String, val applicantName: String,
    val applicantPhone: String, val applicantVerified: Boolean, val taskTitle: String,
    val message: String, val status: String, val reward: String, val currency: String,
    val workerCapacity: Int, val acceptedWorkers: Int, val remainingPositions: Int
)

data class WalletTransaction(
    val id: String,
    val type: String,
    val amount: String,
    val status: String,
    val currency: String,
    val description: String,
    val receipt: String
)

private data class ApiResult(
    val success: Boolean,
    val data: String
)

private suspend fun apiRequest(
    endpoint: String,
    method: String = "GET",
    body: JSONObject? = null,
    token: String? = null
): ApiResult = withContext(Dispatchers.IO) {
    try {
        val builder = Request.Builder()
            .url("$API_BASE_URL$endpoint")
            .addHeader("Accept", "application/json")

        if (!token.isNullOrBlank()) {
            builder.addHeader("Authorization", "Bearer $token")
        }

        when (method) {
            "POST" -> builder.post(
                (body ?: JSONObject()).toString().toRequestBody(jsonMediaType)
            )
            else -> builder.get()
        }

        httpClient.newCall(builder.build()).execute().use { response ->
            ApiResult(
                success = response.isSuccessful,
                data = response.body?.string().orEmpty()
            )
        }
    } catch (e: Exception) {
        ApiResult(false, e.message ?: "Network connection failed")
    }
}

private fun parseTasks(json: String): List<MikroTask> {
    return try {
        val root = JSONObject(json)
        val array = root.optJSONArray("tasks")
            ?: root.optJSONArray("data")
            ?: JSONArray()

        buildList {
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                add(
                    MikroTask(
                        id = item.optString("id"),
                        title = item.optString("title", "Untitled task"),
                        description = item.optString("description"),
                        category = item.optString("category", "General"),
                        reward = item.optString("reward", "0"),
                        currency = item.optString("currency", "KES"),
                        owner = item.optString(
                            "owner_name",
                            item.optString("name", "MikroMate user")
                        )
                    )
                )
            }
        }
    } catch (e: Exception) {
        try {
            val array = JSONArray(json)
            buildList {
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    add(
                        MikroTask(
                            id = item.optString("id"),
                            title = item.optString("title", "Untitled task"),
                            description = item.optString("description"),
                            category = item.optString("category", "General"),
                            reward = item.optString("reward", "0"),
                            currency = item.optString("currency", "KES"),
                            owner = item.optString("owner_name", "MikroMate user")
                        )
                    )
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }
}


private fun parseApplications(json: String): List<MikroApplication> {
    return try {
        val array = try {
            // Handle the raw JSON array returned by the API
            JSONArray(json)
        } catch (_: Exception) {
            // Also support wrapped API responses
            val root = JSONObject(json)
            root.optJSONArray("applications")
                ?: root.optJSONArray("data")
                ?: JSONArray()
        }

        buildList {
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val task = item.optJSONObject("task")

                add(
                    MikroApplication(
                        taskId = item.optString("task_id"),
                        title = item.optString(
                            "title",
                            task?.optString("title", "Task application")
                                ?: "Task application"
                        ),
                        status = item.optString(
                            "application_status",
                            item.optString("status", "PENDING")
                        ),
                        reward = item.optString(
                            "reward",
                            task?.optString("reward", "0") ?: "0"
                        ),
                        currency = item.optString(
                            "currency",
                            task?.optString("currency", "KES") ?: "KES"
                        )
                    )
                )
            }
        }
    } catch (e: Exception) {
        emptyList()
    }
}


private fun parsePosterApplications(json: String): List<PosterApplication> {
    return try {
        val array = JSONObject(json).optJSONArray("applications") ?: JSONArray()
        buildList {
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                add(PosterApplication(
                    applicationId = item.optString("application_id"),
                    taskId = item.optString("task_id"),
                    applicantName = item.optString("applicant_name", "MikroMate applicant"),
                    applicantPhone = item.optString("applicant_phone", ""),
                    applicantVerified = item.optInt("applicant_verified", 0) == 1,
                    taskTitle = item.optString("task_title", "Task"),
                    message = item.optString("message", ""),
                    status = item.optString("application_status", "PENDING"),
                    reward = item.optString("reward", "0"),
                    currency = item.optString("currency", "KES"),
                    workerCapacity = item.optInt("worker_capacity", 1),
                    acceptedWorkers = item.optInt("accepted_workers", 0),
                    remainingPositions = item.optInt("remaining_positions", 0)
                ))
            }
        }
    } catch (_: Exception) { emptyList() }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                MikroMateApp()
            }
        }
    }
}

@Composable
fun MikroMateApp() {
    var token by remember { mutableStateOf("") }
    var userName by remember { mutableStateOf("") }
    var userEmail by remember { mutableStateOf("") }

    var page by remember { mutableStateOf("Login") }
    var selectedTab by remember { mutableStateOf("Home") }

    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var fullName by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var countryCode by remember { mutableStateOf("KE") }

    var message by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    var tasks by remember { mutableStateOf<List<MikroTask>>(emptyList()) }
    var appliedTaskIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var applications by remember {
        mutableStateOf<List<MikroApplication>>(emptyList())
    }
    var receivedApplications by remember {
        mutableStateOf<List<PosterApplication>>(emptyList())
    }
    var walletBalance by remember { mutableStateOf("0.00") }
    var walletTransactions by remember { mutableStateOf<List<WalletTransaction>>(emptyList()) }
    var depositAmount by remember { mutableStateOf("") }
    var depositPhone by remember { mutableStateOf(phone) }

    var taskTitle by remember { mutableStateOf("") }
    var taskDescription by remember { mutableStateOf("") }
    var taskCategory by remember { mutableStateOf("General") }
    var taskReward by remember { mutableStateOf("") }
    var taskCurrency by remember { mutableStateOf("KES") }
    var taskWorkerCapacity by remember { mutableStateOf("1") }

    val scope = rememberCoroutineScope()

    fun loadTasks() {
        scope.launch {
            busy = true
            val result = apiRequest("/api/tasks")
            if (result.success) {
                tasks = parseTasks(result.data)
                val myApplications = apiRequest(
                    "/api/my-applications",
                    token = token
                )
                if (myApplications.success) {
                    val loadedApplications = parseApplications(myApplications.data)
                    applications = loadedApplications
                    appliedTaskIds = appliedTaskIds + loadedApplications.map { it.taskId }.filter { it.isNotBlank() }
                }
                message = ""
            } else {
                message = "Could not load tasks. Please try again."
            }
            busy = false
        }
    }

    fun loadApplications() {
        scope.launch {
            busy = true
            val result = apiRequest(
                "/api/my-applications",
                token = token
            )
            if (result.success) {
                applications = parseApplications(result.data)
                appliedTaskIds = appliedTaskIds + applications.map { it.taskId }.filter { it.isNotBlank() }
                message = ""
            } else {
                message = "Could not load your applications."
            }
            busy = false
        }
    }

    fun loadWallet() {
        scope.launch {
            busy = true
            val result = apiRequest("/api/wallet", token = token)
            if (result.success) {
                try {
                    val root = JSONObject(result.data)
                    val wallets = root.optJSONArray("wallets") ?: JSONArray()
                    var balance = "0.00"
                    for (i in 0 until wallets.length()) {
                        val wallet = wallets.optJSONObject(i) ?: continue
                        if (wallet.optString("currency") == "KES") {
                            balance = wallet.optString("balance", "0.00")
                            break
                        }
                    }
                    walletBalance = balance
                    val entries = root.optJSONArray("transactions") ?: JSONArray()
                    walletTransactions = buildList {
                        for (i in 0 until entries.length()) {
                            val item = entries.optJSONObject(i) ?: continue
                            add(WalletTransaction(
                                id = item.optString("id"),
                                type = item.optString("transaction_type", "TRANSACTION"),
                                amount = item.optString("amount", "0.00"),
                                status = item.optString("status", "PENDING"),
                                currency = item.optString("currency", "KES"),
                                description = item.optString("description", ""),
                                receipt = item.optString("provider_receipt", "")
                            ))
                        }
                    }
                    message = ""
                } catch (_: Exception) {
                    message = "Could not read wallet information."
                }
            } else {
                message = try {
                    JSONObject(result.data).optString("error", "Could not load your wallet.")
                } catch (_: Exception) { "Could not load your wallet." }
            }
            busy = false
        }
    }

    fun depositWithMpesa() {
        val amount = depositAmount.trim().toBigDecimalOrNull()
        if (amount == null || amount <= java.math.BigDecimal.ZERO) {
            message = "Enter a valid deposit amount."
            return
        }
        if (depositPhone.isBlank()) {
            message = "Enter the M-PESA phone number."
            return
        }
        scope.launch {
            busy = true
            message = "Sending M-PESA payment request..."
            val body = JSONObject().apply {
                put("amount", amount.stripTrailingZeros().toPlainString())
                put("phone", depositPhone.trim())
                put("currency", "KES")
            }
            val result = apiRequest("/api/wallet/deposits/mpesa", "POST", body, token)
            if (result.success) {
                val response = try { JSONObject(result.data) } catch (_: Exception) { JSONObject() }
                message = response.optString(
                    "customer_message",
                    "M-PESA request sent. Check your phone and enter your PIN."
                )
                depositAmount = ""
                loadWallet()
            } else {
                message = try {
                    JSONObject(result.data).optString("error", "Could not start M-PESA deposit.")
                } catch (_: Exception) { "Could not start M-PESA deposit. Please try again." }
                busy = false
            }
        }
    }

    fun loadPosterApplications() {
        scope.launch {
            busy = true
            val result = apiRequest("/api/poster/applications", token = token)
            if (result.success) {
                receivedApplications = parsePosterApplications(result.data)
                message = ""
            } else {
                message = try { JSONObject(result.data).optString("error", "Could not load received applications.") }
                catch (_: Exception) { "Could not load received applications." }
            }
            busy = false
        }
    }

    fun decidePosterApplication(application: PosterApplication, accept: Boolean) {
        scope.launch {
            busy = true
            val action = if (accept) "accept" else "reject"
            val result = apiRequest(
                "/api/applications/${application.applicationId}/${action}",
                "POST", JSONObject(), token
            )
            if (result.success) {
                message = if (accept) "Applicant accepted for ${application.taskTitle}." else "Application rejected."
                loadPosterApplications()
            } else {
                message = try { JSONObject(result.data).optString("error", "Could not update this application.") }
                catch (_: Exception) { "Could not update this application." }
                busy = false
            }
        }
    }

    fun loginOrRegister(register: Boolean) {
        if (email.isBlank() || password.isBlank()) {
            message = "Please enter your email and password."
            return
        }

        if (register && fullName.isBlank()) {
            message = "Please enter your full name."
            return
        }

        scope.launch {
            busy = true
            message = "Connecting to MikroMate..."

            val body = JSONObject().apply {
                put("email", email.trim())
                put("password", password)
                if (register) {
                    put("name", fullName.trim())
                    put("phone", phone.trim())
                    put("country_code", countryCode.trim().uppercase())
                }
            }

            val endpoint = if (register) {
                "/api/auth/register"
            } else {
                "/api/auth/login"
            }

            val result = apiRequest(endpoint, "POST", body)

            if (result.success) {
                try {
                    val response = JSONObject(result.data)
                    token = response.optString("token")
                    val user = response.optJSONObject("user")

                    userName = user?.optString("name", fullName)
                        ?: fullName
                    userEmail = user?.optString("email", email)
                        ?: email

                    if (token.isBlank()) {
                        message = "The server did not return a login token."
                    } else {
                        page = "Marketplace"
                        selectedTab = "Home"
                        message = "Welcome to MikroMate!"
                        loadTasks()
                    }
                } catch (_: Exception) {
                    message = "Could not read the server response."
                }
            } else {
                message = try {
                    JSONObject(result.data).optString(
                        "error",
                        "Login or registration failed. Please check your details."
                    )
                } catch (_: Exception) {
                    "Connection failed. Please try again."
                }
            }

            busy = false
        }
    }

    fun requestPasswordReset() {
        if (email.isBlank()) {
            message = "Enter your email address first."
            return
        }

        scope.launch {
            busy = true
            val result = apiRequest(
                "/api/auth/forgot-password",
                "POST",
                JSONObject().put("email", email.trim())
            )
            message = if (result.success) {
                "If the account exists, a password reset link has been sent to your email."
            } else {
                "We could not request a reset link. Please try again."
            }
            busy = false
        }
    }

fun applyForTask(task: MikroTask) {
    if (task.id in appliedTaskIds || busy) return

    scope.launch {
        if (task.id in appliedTaskIds || busy) return@launch
        busy = true
        message = "Submitting your application..."

        try {
            val result = apiRequest(
                "/api/tasks/${task.id}/applications",
                "POST",
                JSONObject().put(
                    "message",
                    "I am interested in this task."
                ),
                token
            )

            if (result.success) {
                appliedTaskIds = appliedTaskIds + task.id
                message = "Your application was submitted."
            } else {
                val error = try {
                    JSONObject(result.data).optString(
                        "error",
                        "Application failed. Please try again."
                    ).ifBlank {
                        "Application failed. Please try again."
                    }
                } catch (_: Exception) {
                    "Application failed. Please try again."
                }

                if (error.contains("already applied", ignoreCase = true)) {
                    appliedTaskIds = appliedTaskIds + task.id
                    message = "You have already applied for this task."
                } else {
                    message = error
                }
            }
        } finally {
            busy = false
        }
    }
}


    fun postTask() {
        val reward = taskReward.toDoubleOrNull()

        if (taskTitle.isBlank() ||
            taskDescription.isBlank() ||
            reward == null ||
            reward <= 0
        ) {
            message = "Enter a title, description and valid reward."
            return
        }

        scope.launch {
            busy = true
            val body = JSONObject().apply {
                put("title", taskTitle.trim())
                put("description", taskDescription.trim())
                put("category", taskCategory.trim())
                put("reward", reward)
                put("currency", taskCurrency)
                put("worker_capacity", taskWorkerCapacity.toIntOrNull() ?: 1)
            }

            val result = apiRequest(
                "/api/tasks",
                "POST",
                body,
                token
            )

            if (result.success) {
                message = "Your task has been posted."
                taskTitle = ""
                taskDescription = ""
                taskReward = ""
                taskWorkerCapacity = "1"
                selectedTab = "Browse"
                loadTasks()
            } else {
                message = try {
                    JSONObject(result.data).optString(
                        "error",
                        "Could not post your task."
                    )
                } catch (_: Exception) {
                    "Could not post your task. Please try again."
                }
            }
            busy = false
        }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background
    ) {
        if (page == "Login" || page == "Register") {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(22.dp),
                verticalArrangement = Arrangement.Center
            ) {
                Text(
                    "MikroMate",
                    style = MaterialTheme.typography.headlineLarge,
                    color = MaterialTheme.colorScheme.primary
                )
                Text("Your tasks. Your opportunities.")

                Spacer(Modifier.height(24.dp))

                Text(
                    if (page == "Login") "Welcome back" else "Create your account",
                    style = MaterialTheme.typography.headlineSmall
                )

                if (page == "Register") {
                    OutlinedTextField(
                        value = fullName,
                        onValueChange = { fullName = it },
                        label = { Text("Full name") },
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = phone,
                        onValueChange = { phone = it },
                        label = { Text("Phone number") },
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = countryCode,
                        onValueChange = { countryCode = it },
                        label = { Text("Country code (e.g. KE)") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }

                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email address") },
                    modifier = Modifier.fillMaxWidth()
                )

                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(Modifier.height(16.dp))

                Button(
                    onClick = {
                        loginOrRegister(page == "Register")
                    },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        if (busy) "Please wait..."
                        else if (page == "Login") "Log in"
                        else "Create account"
                    )
                }

                TextButton(
                    onClick = {
                        page = if (page == "Login") "Register" else "Login"
                        message = ""
                    }
                ) {
                    Text(
                        if (page == "Login") {
                            "Don't have an account? Register"
                        } else {
                            "Already have an account? Log in"
                        }
                    )
                }

                TextButton(
                    onClick = { requestPasswordReset() },
                    enabled = !busy
                ) {
                    Text("Forgot password?")
                }

                if (message.isNotBlank()) {
                    Text(
                        message,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
            }
        } else {
            Column(modifier = Modifier.fillMaxSize()) {
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp)
                ) {
                    Text(
                        "MikroMate",
                        style = MaterialTheme.typography.headlineMedium,
                        color = MaterialTheme.colorScheme.primary
                    )

                    if (message.isNotBlank()) {
                        Text(
                            message,
                            color = MaterialTheme.colorScheme.primary
                        )
                        Spacer(Modifier.height(8.dp))
                    }

                    when (selectedTab) {
                        "Home" -> {
                            Text(
                                "Welcome, $userName!",
                                style = MaterialTheme.typography.headlineSmall
                            )
                            Spacer(Modifier.height(8.dp))
                            Text("Find opportunities. Offer your skills. Get tasks done.")
                            Spacer(Modifier.height(20.dp))

                            Button(
                                onClick = {
                                    selectedTab = "Browse"
                                    loadTasks()
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("Browse available tasks")
                            }

                            OutlinedButton(
                                onClick = { selectedTab = "Post" },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("Post a new task")
                            }

                            OutlinedButton(
                                onClick = {
                                    selectedTab = "Applications"
                                    loadApplications()
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("View my applications")
                            }
                            OutlinedButton(
                                onClick = {
                                    selectedTab = "Received"
                                    loadPosterApplications()
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("Review received applications")
                            }
                            OutlinedButton(
                                onClick = {
                                    selectedTab = "Wallet"
                                    loadWallet()
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("Open MikroMate Wallet")
                            }
                        }

                        "Wallet" -> {
                            Text("MikroMate Wallet", style = MaterialTheme.typography.headlineSmall)
                            Spacer(Modifier.height(8.dp))
                            Card(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(16.dp)) {
                                    Text("Available KES balance", style = MaterialTheme.typography.labelLarge)
                                    Text("KSh $walletBalance", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
                                    Text("Your balance changes only after a verified M-PESA payment is confirmed.")
                                }
                            }
                            Spacer(Modifier.height(16.dp))
                            Text("Add money with M-PESA", style = MaterialTheme.typography.titleLarge)
                            OutlinedTextField(
                                value = depositPhone,
                                onValueChange = { depositPhone = it },
                                label = { Text("M-PESA phone number") },
                                placeholder = { Text("0712345678") },
                                modifier = Modifier.fillMaxWidth()
                            )
                            OutlinedTextField(
                                value = depositAmount,
                                onValueChange = { depositAmount = it.filter { ch -> ch.isDigit() || ch == '.' }.take(12) },
                                label = { Text("Amount (KES)") },
                                placeholder = { Text("100") },
                                modifier = Modifier.fillMaxWidth()
                            )
                            Spacer(Modifier.height(8.dp))
                            Button(onClick = { depositWithMpesa() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                                Text(if (busy) "Please wait..." else "Deposit with M-PESA")
                            }
                            Spacer(Modifier.height(12.dp))
                            OutlinedButton(onClick = { loadWallet() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                                Text("Refresh wallet")
                            }
                            Spacer(Modifier.height(20.dp))
                            Text("Wallet activity", style = MaterialTheme.typography.titleLarge)
                            if (walletTransactions.isEmpty()) Text("No wallet transactions yet.")
                            else walletTransactions.forEach { entry ->
                                Card(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                                    Column(Modifier.padding(12.dp)) {
                                        Text(entry.description.ifBlank { entry.type.replace('_', ' ') }, style = MaterialTheme.typography.titleMedium)
                                        Text("${entry.currency} ${entry.amount}")
                                        Text("Status: ${entry.status}")
                                        if (entry.receipt.isNotBlank()) Text("M-PESA receipt: ${entry.receipt}")
                                    }
                                }
                            }
                        }

                        "Browse" -> {
                            Text(
                                "Available Tasks",
                                style = MaterialTheme.typography.headlineSmall
                            )

                            Button(
                                onClick = { loadTasks() },
                                enabled = !busy
                            ) {
                                Text("Refresh tasks")
                            }

                            if (busy) {
                                CircularProgressIndicator()
                            } else if (tasks.isEmpty()) {
                                Text("No available tasks were returned. Try refreshing later.")
                            }

                            tasks.forEach { task ->
                                Card(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 7.dp)
                                ) {
                                    Column(Modifier.padding(14.dp)) {
                                        Text(
                                            task.title,
                                            style = MaterialTheme.typography.titleLarge
                                        )
                                        Text("Category: ${task.category}")
                                        Text(task.description)
                                        Text("Posted by: ${task.owner}")
                                        Text(
                                            "Reward: ${task.currency} ${task.reward}",
                                            color = MaterialTheme.colorScheme.primary
                                        )
                                        Spacer(Modifier.height(8.dp))
                                        Button(
                                            onClick = { applyForTask(task) },
                                            enabled = !busy && task.id !in appliedTaskIds
                                        ) {
                                            Text(
                                                if (task.id in appliedTaskIds) "Applied"
                                                else "Apply for this task"
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        "Post" -> {
                            Text(
                                "Post a Task",
                                style = MaterialTheme.typography.headlineSmall
                            )
                            Text("Describe the work and set its reward.")

                            OutlinedTextField(
                                value = taskTitle,
                                onValueChange = { taskTitle = it },
                                label = { Text("Task title") },
                                modifier = Modifier.fillMaxWidth()
                            )
                            OutlinedTextField(
                                value = taskDescription,
                                onValueChange = { taskDescription = it },
                                label = { Text("Task description") },
                                modifier = Modifier.fillMaxWidth(),
                                minLines = 3
                            )
                            OutlinedTextField(
                                value = taskCategory,
                                onValueChange = { taskCategory = it },
                                label = { Text("Category") },
                                modifier = Modifier.fillMaxWidth()
                            )
                            OutlinedTextField(
                                value = taskReward,
                                onValueChange = { taskReward = it },
                                label = { Text("Reward amount") },
                                modifier = Modifier.fillMaxWidth()
                            )
                            OutlinedTextField(
                                value = taskCurrency,
                                onValueChange = {
                                    taskCurrency = it.uppercase()
                                },
                                label = { Text("Currency (KES, USD, UGX, TZS, RWF, ZAR, GBP, EUR)") },
                                modifier = Modifier.fillMaxWidth()
                            )
                            OutlinedTextField(
                                value = taskWorkerCapacity,
                                onValueChange = { taskWorkerCapacity = it.filter(Char::isDigit).take(4) },
                                label = { Text("Number of workers needed (default 1)") },
                                modifier = Modifier.fillMaxWidth(),
                                supportingText = { Text("Choose between 1 and 1000 workers.") }
                            )

                            Spacer(Modifier.height(12.dp))

                            Button(
                                onClick = { postTask() },
                                enabled = !busy,
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("Publish task")
                            }
                        }

                        "Applications" -> {
                            Text(
                                "My Applications",
                                style = MaterialTheme.typography.headlineSmall
                            )

                            Button(
                                onClick = { loadApplications() },
                                enabled = !busy
                            ) {
                                Text("Refresh applications")
                            }

                            if (busy) {
                                CircularProgressIndicator()
                            } else if (applications.isEmpty()) {
                                Text("No applications were returned yet.")
                            }

                            applications.forEach { application ->
                                Card(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 6.dp)
                                ) {
                                    Column(Modifier.padding(14.dp)) {
                                        Text(
                                            application.title,
                                            style = MaterialTheme.typography.titleMedium
                                        )
                                        Text("Status: ${application.status}")
                                        Text(
                                            "Reward: ${application.currency} ${application.reward}"
                                        )
                                    }
                                }
                            }
                        }

                        "Received" -> {
                            Text("Applications Received", style = MaterialTheme.typography.headlineSmall)
                            Text("Review applicants for tasks you posted. Accepted workers count toward each task's capacity.")
                            Spacer(Modifier.height(8.dp))
                            Button(onClick = { loadPosterApplications() }, enabled = !busy) {
                                Text("Refresh received applications")
                            }
                            if (busy) CircularProgressIndicator()
                            else if (receivedApplications.isEmpty()) Text("No applications have been received for your tasks yet.")
                            receivedApplications.forEach { application ->
                                Card(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                        Text(application.taskTitle, style = MaterialTheme.typography.titleMedium)
                                        Text("Applicant: ${application.applicantName}")
                                        if (application.applicantPhone.isNotBlank()) Text("Phone: ${application.applicantPhone}")
                                        Text(if (application.applicantVerified) "Verified account" else "Verification not confirmed")
                                        if (application.message.isNotBlank()) Text("Message: ${application.message}")
                                        Text("Application: ${application.status}")
                                        Text("Reward: ${application.currency} ${application.reward}")
                                        Text("Workers accepted: ${application.acceptedWorkers} / ${application.workerCapacity}")
                                        Text("Positions remaining: ${application.remainingPositions}")
                                        if (application.status == "PENDING") {
                                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                                Button(
                                                    onClick = { decidePosterApplication(application, true) },
                                                    enabled = !busy && application.remainingPositions > 0,
                                                    modifier = Modifier.weight(1f)
                                                ) { Text("Accept") }
                                                OutlinedButton(
                                                    onClick = { decidePosterApplication(application, false) },
                                                    enabled = !busy,
                                                    modifier = Modifier.weight(1f)
                                                ) { Text("Reject") }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        "Profile" -> {
                            Text(
                                "My Profile",
                                style = MaterialTheme.typography.headlineSmall
                            )
                            Spacer(Modifier.height(12.dp))
                            Text("Name: $userName")
                            Text("Email: $userEmail")
                            Text("Account connected to MikroMate.")

                            Spacer(Modifier.height(20.dp))

                            Button(
                                onClick = {
                                    token = ""
                                    userName = ""
                                    userEmail = ""
                                    page = "Login"
                                    selectedTab = "Home"
                                    message = "You have logged out."
                                },
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("Log out")
                            }
                        }
                    }
                }

                HorizontalDivider()

                NavigationBar {
                    listOf(
                        "Home",
                        "Browse",
                        "Wallet",
                        "Post",
                        "Profile"
                    ).forEach { tab ->
                        NavigationBarItem(
                            selected = selectedTab == tab,
                            onClick = {
                                selectedTab = tab
                                message = ""
                                when (tab) {
                                    "Browse" -> loadTasks()
                                    "Applications" -> loadApplications()
                                    "Received" -> loadPosterApplications()
                                    "Wallet" -> loadWallet()
                                }
                            },
                            icon = {},
                            label = { Text(tab) }
                        )
                    }
                }
            }
        }
    }
}
