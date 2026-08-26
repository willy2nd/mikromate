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

data class Task(val title:String,val category:String,val reward:Int,val description:String)

class MainActivity:ComponentActivity(){
 override fun onCreate(savedInstanceState:Bundle?){super.onCreate(savedInstanceState);setContent{MikroMate()}}
}
@Composable fun MikroMate(){
 var tab by remember{mutableStateOf("market")}
 var showPost by remember{mutableStateOf(false)}
 var tasks by remember{mutableStateOf(listOf(
 Task("Translate an English notice into Kiswahili","Translation",250,"About 250 words."),
 Task("Explain Form 3 Geography: river transportation","Teaching",400,"Simple explanation with examples."),
 Task("Format a two-page CV","Writing",500,"Professional Microsoft Word layout.")
 ))}
 Scaffold(topBar={TopAppBar(title={Text("MikroMate")},actions={TextButton({showPost=true}){Text("Post")}})}){
  Column(Modifier.padding(it).padding(16.dp)){
   Text("Small jobs. Real skills. Quick value.",style=MaterialTheme.typography.headlineSmall)
   Row(horizontalArrangement=Arrangement.spacedBy(8.dp),modifier=Modifier.padding(vertical=8.dp)){
    Button({tab="market"}){Text("Jobs")}; OutlinedButton({tab="earn"}){Text("Earn")}; OutlinedButton({tab="wallet"}){Text("Wallet")}
   }
   if(tab=="market") LazyColumn(verticalArrangement=Arrangement.spacedBy(10.dp)){
    items(tasks){t->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(16.dp)){
     Text(t.category,style=MaterialTheme.typography.labelMedium);Text(t.title,style=MaterialTheme.typography.titleMedium)
     Text(t.description);Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
      Text("KSh ${t.reward}",style=MaterialTheme.typography.titleLarge);Button({}){Text("Offer")}}
    }}}
   } else if(tab=="earn") Card{Column(Modifier.padding(16.dp)){Text("How providers earn",style=MaterialTheme.typography.titleLarge);Text("Accept a task, complete it, and receive the provider amount after the platform's payment/release rules. MikroMate's default fee is 10%.")}}
   else Card{Column(Modifier.padding(16.dp)){Text("Wallet",style=MaterialTheme.typography.titleLarge);Text("Production wallet balance and withdrawal history will be populated by verified backend transactions.")}}
  }
 }
 if(showPost) PostDialog({showPost=false}){title,cat,amount,desc->tasks=listOf(Task(title,cat,amount,desc))+tasks;showPost=false}
}
@Composable fun PostDialog(close:()->Unit,post:(String,String,Int,String)->Unit){
 var title by remember{mutableStateOf("")};var cat by remember{mutableStateOf("Writing")};var amount by remember{mutableStateOf("300")};var desc by remember{mutableStateOf("")}
 AlertDialog(onDismissRequest=close,title={Text("Post a job")},text={Column(verticalArrangement=Arrangement.spacedBy(8.dp)){
  OutlinedTextField(title,{title=it},label={Text("Title")});OutlinedTextField(cat,{cat=it},label={Text("Category")})
  OutlinedTextField(amount,{amount=it.filter(Char::isDigit)},label={Text("Reward")});OutlinedTextField(desc,{desc=it},label={Text("Details")},minLines=3)
 }},confirmButton={Button({val a=amount.toIntOrNull()?:0;if(title.isNotBlank()&&desc.isNotBlank()&&a>=50)post(title,cat,a,desc)}){Text("Publish")}},dismissButton={TextButton(close){Text("Cancel")}})
}