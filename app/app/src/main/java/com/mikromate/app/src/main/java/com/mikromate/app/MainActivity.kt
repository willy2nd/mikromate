package com.mikromate.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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

@Composable
fun MikroMateApp() {
    var selectedTab by remember { mutableStateOf("Jobs") }

    MaterialTheme {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text("MikroMate") }
                )
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
                    text = "Welcome to MikroMate",
                    style = MaterialTheme.typography.headlineSmall
                )
                Spacer(modifier = Modifier.height(16.dp))

                when (selectedTab) {
                    "Jobs" -> {
                        Text("Find opportunities and complete tasks.")
                        Spacer(modifier = Modifier.height(12.dp))
                        Text("Available tasks")
                        listOf(
                            "Online research",
                            "Data entry",
                            "Writing assistance"
                        ).forEach { task ->
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 6.dp)
                            ) {
                                Text(
                                    text = task,
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
}
