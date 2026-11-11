
package com.mikromate.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MikroMateApp()
        }
    }
}

data class MikroTask(
    val title: String,
    val description: String
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MikroMateApp() {
    var selectedTab by remember { mutableStateOf("Jobs") }
    var selectedTask by remember { mutableStateOf<MikroTask?>(null) }
    var showOfferMessage by remember { mutableStateOf(false) }

    val tasks = listOf(
        MikroTask(
            "Online research",
            "Help with online research and information gathering. Reward details will be confirmed when the live job service is connected."
        ),
        MikroTask(
            "Data entry",
            "Help organize and enter information accurately. Reward details will be confirmed when the live job service is connected."
        ),
        MikroTask(
            "Writing assistance",
            "Help prepare and organize written content. Reward details will be confirmed when the live job service is connected."
        )
    )

    MaterialTheme {
        Scaffold(
            topBar = {
                TopAppBar(title = { Text("MikroMate") })
            },
            bottomBar = {
                NavigationBar {
                    listOf("Jobs", "Earn", "Wallet").forEach { tab ->
                        NavigationBarItem(
                            selected = selectedTab == tab,
                            onClick = { selectedTab = tab },
                            icon = {},
                            label = { Text(tab) }
                        )
                    }
                }
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(16.dp)
            ) {
                Text(
                    "Welcome to MikroMate",
                    style = MaterialTheme.typography.headlineSmall
                )

                Spacer(modifier = Modifier.height(16.dp))

                when (selectedTab) {
                    "Jobs" -> {
                        Text("Find opportunities and complete tasks.")
                        Spacer(modifier = Modifier.height(12.dp))
                        Text("Available tasks")

                        tasks.forEach { task ->
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 6.dp)
                                    .clickable {
                                        selectedTask = task
                                    }
                            ) {
                                Text(
                                    task.title,
                                    modifier = Modifier.padding(16.dp)
                                )
                            }
                        }
                    }

                    "Earn" -> {
                        Text("Discover ways to earn through MikroMate.")
                    }

                    "Wallet" -> {
                        Text("Your MikroMate wallet")
                        Spacer(modifier = Modifier.height(8.dp))
                        Text("Balance: KSh 0.00")
                    }
                }
            }
        }
    }

    selectedTask?.let { task ->
        AlertDialog(
            onDismissRequest = { selectedTask = null },
            title = { Text(task.title) },
            text = { Text(task.description) },
            confirmButton = {
                TextButton(
                    onClick = {
                        selectedTask = null
                        showOfferMessage = true
                    }
                ) {
                    Text("Offer to do this job")
                }
            },
            dismissButton = {
                TextButton(onClick = { selectedTask = null }) {
                    Text("Close")
                }
            }
        )
    }

    if (showOfferMessage) {
        AlertDialog(
            onDismissRequest = { showOfferMessage = false },
            title = { Text("MikroMate") },
            text = {
                Text(
                    "This is a demo action. Your job offer has not been sent to the live MikroMate service yet."
                )
            },
            confirmButton = {
                TextButton(onClick = { showOfferMessage = false }) {
                    Text("OK")
                }
            }
        )
    }
}
