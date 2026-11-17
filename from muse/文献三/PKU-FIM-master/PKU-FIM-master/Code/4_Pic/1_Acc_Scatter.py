# -*-coding:utf-8 -*-
# python3.9
# 对比predicted和observed的value和acc

"""
# @File       : 1_Acc_Scatter.py
# @software   : PyCharm  
# @Time       ：2024/6/22 13:56
# @Author     ：Wei Lyu
"""

import numpy as np
import matplotlib.pyplot as plt
import pandas as pd

plt.rcParams['pdf.fonttype'] = 42

if __name__ == '__main__':
    path = 'D:/LW/ABM'

    outputPath = path + '/OutputData'

    sigma = 1
    granularity = '3km'
    flow_type = 'inflow'
    shelter_weight = 0.1
    pic_storagePath = outputPath + '/Result/pic/' + 'sigma=' + str(sigma) + '/' + flow_type.capitalize()

    colors = ["#EDA6B6", "#3E5082"]
    # colors = ["#CCA3B3", "#9D9CBD"]
    cities = ['shenzhen', 'zhengzhou']
    labels = ['Shenzhen', 'Zhengzhou']

    plt.figure(figsize=(5, 4))

    for i in range(2):
        city = cities[i]
        basePath = outputPath + '/Result/' + city + '/' + 'shelter weight-' + str(shelter_weight) + '/' + granularity + '/sigma=' + str(sigma)
        accuracy = np.load(basePath + '/' + flow_type + 'Accuracy.npy')
        plt.plot(range(len(accuracy)), accuracy, marker='o', linestyle='-', color=colors[i], label=labels[i], alpha=0.3)

    plt.xlabel('Generation', fontsize=12)
    plt.ylabel('Accuracy', fontsize=12)

    plt.xticks(fontsize=12)
    plt.yticks(fontsize=12)
    plt.ylim(0, 1)
    plt.xlim(xmax=170)
    plt.xticks(range(0, 170, 25))

    plt.legend(loc='lower right', fontsize=12, frameon=True)

    # 关闭上和右框线
    ax = plt.gca()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)

    # 显示图表
    plt.savefig(pic_storagePath + '/' + flow_type + '_accuracy_' + granularity + '.pdf')
    plt.savefig(pic_storagePath + '/' + flow_type + '_accuracy_' + granularity + '.png', dpi=300)
    # plt.show()


    # scatter plot ------------------------------------------------------------------

    plt.figure(figsize=(8, 6))

    for i in range(2):
        city = cities[i]
        basePath = outputPath + '/Result/' + city + '/' + 'shelter weight-' + str(shelter_weight) + '/' + granularity + '/sigma=' + str(sigma)
        PredTru = pd.read_csv(basePath + '/' + flow_type + 'PredTru.csv', header=0)

        x = np.array(PredTru['pred_' + flow_type])
        y = np.array(PredTru['tru_' + flow_type])
        x = (x - np.nanmin(x)) / (np.nanmax(x) - np.nanmin(x))
        y = (y - np.nanmin(y)) / (np.nanmax(y) - np.nanmin(y))

        plt.scatter(x, y, c=colors[i], label=labels[i], s=20, alpha=0.5)


    plt.plot(x, x, c='gray', linestyle='--', alpha=0.5)

    plt.xlabel('Simulated volume of inflow', fontsize=12)
    plt.ylabel('Observed volume of inflow', fontsize=12)

    plt.xticks(fontsize=12)
    plt.yticks(fontsize=12)

    plt.legend(loc='lower right', fontsize=12, frameon=True)

    # 关闭上和右框线
    ax = plt.gca()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)

    plt.savefig(pic_storagePath + '/' + 'scatterplot_' + granularity + '.pdf')
    plt.savefig(pic_storagePath + '/' + 'scatterplot_' + granularity + '.png', dpi=300)
    # plt.show()





